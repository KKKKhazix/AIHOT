// Text embeddings through receipts, used only for the event grouping's candidate recall. Any
// OpenAI-compatible /embeddings endpoint (EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL);
// with a DashScope key and nothing else set, Aliyun text-embedding-v4 at 1024 dimensions. Without
// either, recall falls back to the other signals (same address, replies and quotes).
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { paidRequest, ProviderRejectedError } from "./receipts.ts";

const own = !!credential("models", "EMBEDDING_API_KEY");
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || (own ? "text-embedding-3-small" : "text-embedding-v4");
/** Requested dimensions, when the provider takes the parameter (0 leaves it to the model). */
export const EMBEDDING_DIMS = Number(process.env.EMBEDDING_DIMS ?? (own ? 0 : 1024));
const SERVICE = own ? "embedding" : "dashscope";

// Recall reads fresh fact/story titles on every call, so the full text hash also invalidates this
// cache when either title changes. Keep enough entries for the 4,000-fact recall window, not the
// unbounded article history. Expiry also picks up a stored-vector repair with an unchanged hash.
const FACT_CACHE_LIMIT = 4096;
const FACT_CACHE_TTL_MS = 5 * 60_000;
const factVectors = new Map<string, { textHash: string; vector: number[]; expiresAt: number }>();

function cacheFact(id: string, textHash: string, vector: number[]) {
  factVectors.delete(id);
  factVectors.set(id, { textHash, vector, expiresAt: Date.now() + FACT_CACHE_TTL_MS });
  if (factVectors.size > FACT_CACHE_LIMIT) factVectors.delete(factVectors.keys().next().value!);
}

/** Embeddings are paid model calls: MODEL_CALLS_ENABLED=false switches them off like every other call. */
export function embeddingsAvailable(): boolean {
  return config.modelCallsEnabled && !!(credential("models", "EMBEDDING_API_KEY") ?? credential("models", "DASHSCOPE_API_KEY")) && process.env.EMBEDDINGS_ENABLED !== "false";
}

/** 默认维度由提供方决定；显式维度必须匹配，所有坐标都必须是有限数值。 */
export function compatibleEmbedding(vector: unknown): vector is number[] {
  if (!Array.isArray(vector) || vector.length === 0 || (EMBEDDING_DIMS > 0 && vector.length !== EMBEDDING_DIMS)) return false;
  for (const value of vector) if (!Number.isFinite(value)) return false;
  return true;
}

async function embedBatch(texts: string[], subject: string): Promise<number[][]> {
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const base = own ? credential("models", "EMBEDDING_BASE_URL") ?? "https://api.openai.com/v1" : credential("models", "DASHSCOPE_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const key = own ? credential("models", "EMBEDDING_API_KEY") : credential("models", "DASHSCOPE_API_KEY");
  if (!key) throw new Error("EMBEDDING_API_KEY (or DASHSCOPE_API_KEY) missing");
  const receipt = await paidRequest(
    { service: SERVICE, model: EMBEDDING_MODEL, purpose: "embedding", subject, identity: { model: EMBEDDING_MODEL, dims: EMBEDDING_DIMS, texts: texts.map((t) => sha256(t)) }, requestSummary: { count: texts.length } },
    async () => {
      const res = await fetch(`${base.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, ...(EMBEDDING_DIMS > 0 ? { dimensions: EMBEDDING_DIMS } : {}), encoding_format: "float" }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (!res.ok) throw new ProviderRejectedError(`embeddings HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, res.status === 429 || res.status >= 500);
      const json = JSON.parse(text) as { data: Array<{ embedding: number[]; index: number }>; usage?: Record<string, unknown> };
      return { response: json, usage: json.usage ?? null, cost: null };
    },
  );
  const data = (receipt.response as { data?: Array<{ embedding: unknown; index: number }> } | null)?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error("Invalid embedding response: batch size mismatch");
  // 整批校验后再返回，避免部分写入；坏回执仍可复用，不另发付费请求。
  const vectors: number[][] = [];
  for (const d of data) {
    if (!d || !Number.isInteger(d.index) || d.index < 0 || d.index >= texts.length || vectors[d.index] || !compatibleEmbedding(d.embedding)) {
      throw new Error("Invalid embedding response: incompatible vector or index");
    }
    vectors[d.index] = d.embedding;
  }
  return vectors;
}

/** Returns stored embeddings, computing and storing the missing ones. */
export async function ensureEmbeddings(kind: "fact" | "article" | "story", items: Array<{ id: string; text: string }>): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (items.length === 0) return out;
  const hashes = new Map(items.map((item) => [item.id, sha256(item.text)]));
  const now = Date.now();
  const uncached = items.filter((item) => {
    const hit = kind === "fact" ? factVectors.get(item.id) : undefined;
    if (!hit) return true;
    if (hit.textHash !== hashes.get(item.id) || hit.expiresAt <= now || !compatibleEmbedding(hit.vector)) {
      factVectors.delete(item.id);
      return true;
    }
    // Refresh recency, but not expiry: repeated access must not conceal a stored-vector repair.
    factVectors.delete(item.id);
    factVectors.set(item.id, hit);
    out.set(item.id, hit.vector);
    return false;
  });
  const rows = uncached.length ? await sql<{ ref_id: string; text_hash: string; vector: number[] }[]>`
    SELECT ref_id, text_hash, vector FROM embeddings WHERE kind = ${kind} AND model = ${EMBEDDING_MODEL} AND ref_id IN ${sql(uncached.map((i) => i.id))}` : [];
  const have = new Map(rows.map((r) => [r.ref_id, r]));
  const missing = uncached.filter((i) => {
    const h = have.get(i.id);
    if (h && h.text_hash === hashes.get(i.id) && compatibleEmbedding(h.vector)) {
      out.set(i.id, h.vector);
      if (kind === "fact") cacheFact(i.id, h.text_hash, h.vector);
      return false;
    }
    return true;
  });
  for (let i = 0; i < missing.length; i += 10) {
    const batch = missing.slice(i, i + 10);
    const vectors = await embedBatch(batch.map((b) => b.text.slice(0, 2000)), `${kind}:${batch[0]!.id}`);
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j]!;
      const v = vectors[j]!;
      out.set(item.id, v);
      await sql`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector) VALUES (${kind}, ${item.id}, ${EMBEDDING_MODEL}, ${hashes.get(item.id)!}, ${v})
                ON CONFLICT (kind, ref_id, model) DO UPDATE SET text_hash = EXCLUDED.text_hash, vector = EXCLUDED.vector, created_at = now()`;
      // Cache only vectors read back from PostgreSQL. Its real[] text representation can round
      // provider doubles; reusing the provider response here would change later cosine results.
    }
  }
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const score = na && nb ? dot / Math.sqrt(na * nb) : 0;
  return Number.isFinite(score) ? score : 0;
}
