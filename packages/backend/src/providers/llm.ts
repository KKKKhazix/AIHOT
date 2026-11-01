// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless the
// site, an environment variable or the admin's model page picks one of the site's named presets
// (site/models.ts).
import type { z } from "zod";
import type { ModelPreset } from "@aihot/contracts/site-config";
import { PRESETS } from "@aihot/site/models";
import { config, credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import {
  assertAccepted, failureKind, logicalKeyFor, ModelOutputError, ModelUnavailableError, paidRequest, ProviderRejectedError, receiptState, rejectReceivedResponse,
  type ReceiptRequest,
} from "./receipts.ts";
import { enterModelCircuit, recordModelHealth, type CircuitPermit } from "./circuit.ts";

export interface ModelSpec extends ModelPreset {
  key: string;
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

function reasoningTokensFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("LLM_REASONING_TOKENS must be a non-negative integer, e.g. 4000");
  return Number(value);
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get reasoningTokens() { return reasoningTokensFromEnv(process.env.LLM_REASONING_TOKENS); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // The pack's named presets, each with its own address and key.
  ...Object.fromEntries(Object.entries(PRESETS).map(([key, preset]) => [key, { key, ...preset }])),
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  /** One independently operated, evaluated backup. Only availability failures switch providers. */
  fallbackModel?: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

function requestFor<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec) {
  const temperature = opts.temperature ?? 0.2;
  // Never below 512: a smaller cap cut short structured answers down to an empty response (production, 2026-06-19).
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.reasoningTokens ?? 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const request: ReceiptRequest = {
    service: spec.service, model: spec.model, purpose: opts.purpose, subject: opts.subject,
    identity: { model: spec.model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, extra: spec.extra ?? null },
    requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens },
    attemptTag: opts.attemptTag,
  };
  return { request, temperature, maxTokens, userText };
}

/** A call without a backup waits this long for its answer. */
const TIMEOUT_MS = 120_000;
/**
 * A call with an evaluated backup gives up sooner: the backup takes over at once, and the primary's
 * receipt stays unknown (it may be billed as well). On the steps that have a backup, 6 of about 14,000
 * answers took longer than this (99.9% came within it, the slowest in 77 s), while in an outage every
 * call held its work for the full wait before failing.
 */
const FAILOVER_TIMEOUT_MS = 30_000;

/**
 * With a backup (fallbackModel: editorial/models.ts picks one at another provider), a primary whose
 * outcome is unknown, or that the provider turns away for now, is continued by the backup at once:
 * besides the one release in operations/recover.ts, the other place where an unknown outcome is
 * followed by a second paid request.
 */
export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  if (!opts.fallbackModel) return chatOnce(opts);
  const backupOpts = { ...opts, model: opts.fallbackModel };
  const fallbackFor = logicalKeyFor(requestFor(opts, MODELS[opts.model]!).request);
  const saved = await receiptState(requestFor(backupOpts, MODELS[opts.fallbackModel]!).request);
  // Finish an existing backup attempt before choosing a provider again, even after recovery/restart.
  if (saved && saved !== "failed") return chatOnce(backupOpts, true, fallbackFor);
  try {
    return await chatOnce(opts, true);
  } catch (error) {
    const kind = failureKind(error);
    if (kind !== "unknown" && kind !== "outage") throw error;
    return chatOnce(backupOpts, true, fallbackFor);
  }
}

async function chatOnce<S extends z.ZodType>(opts: ChatJsonOptions<S>, circuit = false, fallbackFor?: string): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new ModelUnavailableError("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const baseUrl = credential("models", spec.baseUrlEnv);
  const apiKey = credential("models", spec.apiKeyEnv);
  if (!baseUrl || !apiKey || !spec.model) throw new ModelUnavailableError(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);

  const { request, temperature, maxTokens, userText } = requestFor(opts, spec);
  const timeoutMs = opts.timeoutMs ?? (circuit ? FAILOVER_TIMEOUT_MS : TIMEOUT_MS);
  let permit: CircuitPermit;
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...(spec.extra ?? {}),
  };

  const receipt = await paidRequest(
    { ...request, fallbackFor },
    async () => {
      const started = performance.now();
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
        assertAccepted(spec.service, res.status, text);
      } catch (error) {
        const failure = isConnectFailure(error) ? new ProviderRejectedError(`connect failed: ${String(error)}`, null, true) : error;
        // A refusal is the provider answering; any other failure counts against its availability.
        if (circuit) await recordModelHealth(spec.service, permit!, failureKind(failure) !== "refused");
        throw failure;
      }
      if (circuit) await recordModelHealth(spec.service, permit!, false);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Expected a response object");
      } catch {
        json = { unparsable: text.slice(0, 20000) };
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      return {
        response: { ...json, _latencyMs: Math.round(performance.now() - started) },
        requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
        usage,
        cost: null,
      };
    },
    circuit ? async tx => { permit = await enterModelCircuit(tx, spec.service, timeoutMs); } : undefined,
  );

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer. A reasoning model that
    // reasoned up to the output limit leaves an empty or cut-off answer; say so, and where to give it room.
    const detail = response.choices?.[0]?.finish_reason === "length"
      ? `output token limit reached (finish_reason=length): a reasoning model may have spent it reasoning; give it room with ${spec.key === "default" ? "LLM_REASONING_TOKENS" : `reasoningTokens on preset ${spec.key}`}. ${String(error)}`
      : String(error);
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${detail.slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${detail.slice(0, 300)}`, receipt.receiptId);
  }
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}
