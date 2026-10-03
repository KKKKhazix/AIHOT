// Evaluates the production story-digest prompt on user-supplied cases without writing story data.
// Usage: node --env-file=.env scripts/eval-story-digests.ts --cases .data/story-digest-cases.jsonl
//        [--models default,deepseek-flash] [--concurrency 4]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { modelFor } from "@aihot/backend/editorial/models";
import {
  DIGEST_PROMPT_VERSION,
  STORY_DIGEST_SYSTEM,
  StoryDigestSchema,
  storyDigestPromptContext,
  type StoryDigestPromptReport,
} from "@aihot/backend/events/digest";
import { MODELS, ModelOutputError, chatJson } from "@aihot/backend/providers/llm";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { parseDigestEvalJsonl } from "./eval-story-digests-core.ts";

const { values } = parseArgs({
  options: {
    cases: { type: "string", default: ".data/story-digest-cases.jsonl" },
    models: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

async function pmap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }));
  return out;
}

async function usageFor(receiptIds: number[]) {
  const ids = [...new Set(receiptIds)];
  if (!ids.length) return { tokensIn: 0, tokensOut: 0, avgLatencyMs: 0 };
  const [usage] = await sql<{ tin: number; tout: number; latency: number }[]>`
    SELECT
      sum(coalesce((usage->>'prompt_tokens')::int, (usage->>'input_tokens')::int, 0)) AS tin,
      sum(coalesce((usage->>'completion_tokens')::int, (usage->>'output_tokens')::int, 0)) AS tout,
      avg(latency_ms) AS latency
    FROM receipt_attempts WHERE receipt_id IN ${sql(ids)}`;
  return {
    tokensIn: Number(usage?.tin ?? 0),
    tokensOut: Number(usage?.tout ?? 0),
    avgLatencyMs: Math.round(Number(usage?.latency ?? 0)),
  };
}

async function main() {
  const concurrency = positiveInt(values.concurrency!, "concurrency");
  const rows = parseDigestEvalJsonl(readFileSync(path.resolve(REPO_ROOT, values.cases!), "utf8"));
  if (!rows.length) throw new Error("no digest evaluation cases");

  const models = values.models
    ? values.models.split(",").map((model) => model.trim()).filter(Boolean)
    : [await modelFor("digest")];
  if (!models.length) throw new Error("--models did not name any models");
  for (const model of models) if (!MODELS[model]) throw new Error(`unknown model ${model}`);

  const reportsByCase = new Map(rows.map((row) => [
    row.caseId,
    row.reports
      .map((r): StoryDigestPromptReport => ({
        id: r.id,
        at: new Date(r.publishedAt),
        source_name: r.source,
        first_party: r.firstParty,
        title: r.title,
        summary: r.summary,
      }))
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id)),
  ]));

  const modelReports: Record<string, unknown> = {};
  for (const model of models) {
    const started = Date.now();
    const results = await pmap(rows, concurrency, async (row) => {
      const reports = reportsByCase.get(row.caseId)!;
      const { user } = storyDigestPromptContext(reports);
      try {
        const res = await chatJson({
          model,
          purpose: "eval_story_digest",
          subject: `story-digest-eval:${row.caseId}`,
          promptVersion: DIGEST_PROMPT_VERSION,
          system: STORY_DIGEST_SYSTEM,
          user,
          schema: StoryDigestSchema,
          temperature: 0.3,
          maxTokens: 1200,
        });
        await completeReceipt(sql, res.receiptId);
        return {
          caseId: row.caseId,
          output: res.data,
          receiptId: res.receiptId,
          reused: res.reused,
          error: null as string | null,
        };
      } catch (error) {
        return {
          caseId: row.caseId,
          output: null,
          receiptId: error instanceof ModelOutputError ? error.receiptId : null,
          reused: false,
          error: String(error).slice(0, 500),
        };
      }
    });

    const receiptIds = results.flatMap((result) => result.receiptId === null ? [] : [result.receiptId]);
    modelReports[model] = {
      summary: {
        model,
        cases: rows.length,
        succeeded: results.filter((result) => result.output).length,
        errors: results.filter((result) => result.error).length,
        reused: results.filter((result) => result.reused).length,
        ...(await usageFor(receiptIds)),
        wallSeconds: Math.round((Date.now() - started) / 1000),
      },
      cases: results,
    };
  }

  const outDir = path.join(REPO_ROOT, ".data/eval");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `story-digests-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({
    meta: {
      promptVersion: DIGEST_PROMPT_VERSION,
      createdAt: new Date().toISOString(),
      source: values.cases,
    },
    models: modelReports,
  }, null, 2));
  console.log(`report: ${file}`);
}

try {
  await main();
} finally {
  await closeDb();
}
