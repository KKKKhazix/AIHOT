// One runtime connection shared by API and worker. Only ciphertext is stored in settings.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { MODEL_PROVIDERS, defaultModelExtra, providerForUrl, recognizeModelProvider, type ModelConnectionInput, type ModelConnectionView } from "@aihot/contracts/model-connection";
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";

export interface ModelConnection extends Omit<ModelConnectionView, "hasKey" | "extraJson"> {
  apiKey: string;
  extra: Record<string, unknown>;
}
interface StoredConnection extends Omit<ModelConnection, "apiKey" | "source"> {
  encryptedKey: string;
}
const SETTING = "model_connection";
let cached: { at: number; connection: ModelConnection | null } | null = null;
const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };

function encryptionKey(): Buffer {
  const secret = credential("auth", "SESSION_SECRET");
  if (!secret) return invalid("请先配置 SESSION_SECRET，再在后台保存密钥");
  return createHash("sha256").update(`aihot:model-connection:v1:${secret}`).digest();
}
export function encryptModelKey(apiKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}
export function decryptModelKey(encrypted: string): string {
  try {
    const parts = encrypted.split(".").map((s) => Buffer.from(s, "base64url"));
    if (parts.length !== 3) throw new Error("format");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), parts[0]!);
    decipher.setAuthTag(parts[1]!);
    return Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("保存的模型密钥无法解密；如果更换了 SESSION_SECRET，请在后台重新填写模型密钥");
  }
}
export function normalizeModelBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return invalid("请输入完整的接口地址，例如 https://example.com/v1"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return invalid("接口地址需要 HTTPS，本机地址可使用 HTTP");
  if (url.username || url.password || url.search || url.hash) return invalid("接口地址不能包含账号、密码、查询参数或片段");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}
function parseExtra(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return invalid("额外参数需要是有效的 JSON 对象"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("额外参数需要是 JSON 对象");
  if (Object.keys(parsed).some((k) => ["model", "messages", "stream"].includes(k))) return invalid("额外参数不能覆盖模型、消息或流式设置");
  return parsed as Record<string, unknown>;
}
export function envModelConnection(): ModelConnection {
  const baseUrl = credential("models", "LLM_BASE_URL") ?? "";
  return {
    provider: providerForUrl(baseUrl), baseUrl, model: process.env.LLM_MODEL ?? "",
    apiKey: credential("models", "LLM_API_KEY") ?? "",
    extra: parseExtra(process.env.LLM_EXTRA_JSON || "{}"), source: "env",
  };
}
export async function loadModelConnection(): Promise<ModelConnection> {
  if (!cached || Date.now() - cached.at >= 5000) {
    const [row] = await sql<{ value: StoredConnection }[]>`SELECT value FROM settings WHERE key = ${SETTING}`;
    const c = row?.value;
    cached = { at: Date.now(), connection: c ? { provider: c.provider, baseUrl: c.baseUrl, model: c.model, extra: c.extra, apiKey: decryptModelKey(c.encryptedKey), source: "admin" } : null };
  }
  return cached.connection ?? envModelConnection();
}
export function invalidateConnectionCache(): void { cached = null; }
export function publicModelConnection(c: ModelConnection): ModelConnectionView {
  return { provider: c.provider, baseUrl: c.baseUrl, model: c.model, extraJson: JSON.stringify(c.extra), hasKey: !!c.apiKey, source: c.source };
}

export function resolveModelConnection(input: ModelConnectionInput, previous?: ModelConnection): ModelConnection {
  if (!input || typeof input !== "object") return invalid("请填写模型连接配置");
  const apiKeyInput = String(input.apiKey ?? "").trim();
  if (apiKeyInput.length > 4096 || /\s/.test(apiKeyInput)) return invalid("密钥格式不正确，请重新复制");
  const provider = input.provider === "auto" ? recognizeModelProvider(apiKeyInput) : input.provider;
  if (!provider) return invalid("这个密钥无法可靠识别厂商，请选择服务商；中转站请选择“第三方中转 / 自定义”");
  const preset = MODEL_PROVIDERS.find((p) => p.id === provider);
  if (!preset) return invalid("请选择支持的服务商");
  const baseUrl = normalizeModelBaseUrl(provider === "custom" ? String(input.baseUrl ?? "") : preset.baseUrl);
  const apiKey = apiKeyInput || (previous?.baseUrl === baseUrl ? previous.apiKey : "");
  if (!apiKey) return invalid("请填写这个接口对应的 API Key");
  const model = String(input.model ?? "").trim() || preset.model;
  if (!model || model.length > 200 || /[\s\x00-\x1f]/.test(model)) return invalid("请选择或填写可用的模型名称");
  const extra = input.extraJson?.trim() ? parseExtra(input.extraJson) : defaultModelExtra(provider, model);
  return { provider, baseUrl, apiKey, model, extra, source: "admin" };
}

export async function saveModelConnection(input: ModelConnectionInput, actor: string): Promise<ModelConnectionView> {
  const before = await loadModelConnection();
  const connection = resolveModelConnection(input, before);
  const stored: StoredConnection = { provider: connection.provider, baseUrl: connection.baseUrl, model: connection.model, extra: connection.extra, encryptedKey: encryptModelKey(connection.apiKey) };
  const after = publicModelConnection(connection);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${SETTING}, ${tx.json(stored as never)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "models.connection", "model:default", "后台更新模型接口", publicModelConnection(before), after, { db: tx });
  });
  invalidateConnectionCache();
  return after;
}

/** Model listing is a metadata request, never a chat call or a probe across vendors. */
export async function discoverConnectionModels(input: ModelConnectionInput): Promise<{ models: string[] }> {
  const previous = await loadModelConnection();
  // A model is not needed to list models.
  const c = resolveModelConnection({ ...input, model: input.model || "model-list" }, previous);
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl}/models`, { headers: { authorization: `Bearer ${c.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(12000) });
  } catch { return invalid("无法读取模型列表，请检查接口地址和网络；也可以直接填写平台提供的模型名称"); }
  if (!res.ok) {
    await res.body?.cancel();
    return invalid(res.status === 401 || res.status === 403 ? "接口拒绝访问，请检查密钥和所属地域" : `接口没有提供可读取的模型列表（HTTP ${res.status}），请直接填写模型名称`);
  }
  // Bound untrusted relay responses and never return arbitrary provider payloads or errors.
  let text = "";
  const reader = res.body?.getReader();
  if (!reader) return invalid("接口返回了空模型列表");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); return invalid("模型列表过大，请直接填写模型名称"); }
      chunks.push(chunk.value);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } catch { return invalid("模型列表读取失败，请直接填写模型名称"); }
  let json: { data?: Array<{ id?: unknown }> };
  try { json = JSON.parse(text); } catch { return invalid("接口返回的模型列表格式不兼容，请直接填写模型名称"); }
  if (!Array.isArray(json?.data)) return invalid("接口没有返回兼容的模型列表，请直接填写模型名称");
  const models = [...new Set(json.data.map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\s\x00-\x1f]/.test(id)))].sort().slice(0, 1000);
  if (!models.length) return invalid("没有找到可用模型，请直接填写模型名称");
  return { models };
}
