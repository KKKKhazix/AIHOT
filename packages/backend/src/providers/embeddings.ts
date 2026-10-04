// Text embeddings through receipts, used only for recall. Any OpenAI-compatible /embeddings endpoint
// (EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL); with a DashScope key and nothing else set,
// Aliyun text-embedding-v4 at 1024 dimensions. Without either, recall compares the texts themselves.
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { z } from "zod";
import { ModelOutputError } from "./llm.ts";
import { completeReceipt, paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";

const own = !!credential("models", "EMBEDDING_API_KEY");
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || (own ? "text-embedding-3-small" : "text-embedding-v4");
/** Requested dimensions, when the provider takes the parameter (0 leaves it to the model). */
export const EMBEDDING_DIMS = Number(process.env.EMBEDDING_DIMS ?? (own ? 0 : 1024));
const SERVICE = own ? "embedding" : "dashscope";
/** A vector of the configured size; a stored one of another size (EMBEDDING_DIMS changed) is computed again. */
const VECTOR = EMBEDDING_DIMS > 0 ? z.array(z.number()).length(EMBEDDING_DIMS) : z.array(z.number()).min(1);

/** Embeddings are paid model calls: MODEL_CALLS_ENABLED=false switches them off like every other call. */
export function embeddingsAvailable(): boolean {
  return config.modelCallsEnabled && !!(credential("models", "EMBEDDING_API_KEY") ?? credential("models", "DASHSCOPE_API_KEY"));
}

async function embedBatch(texts: string[], subject: string): Promise<{ vectors: number[][]; receiptId: number }> {
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
      let response: unknown;
      try { response = JSON.parse(text); }
      catch { response = { unparsable: text.slice(0, 20000) }; }
      const usage = response && typeof response === "object" && "usage" in response
        ? response.usage as Record<string, unknown> : null;
      return { response, usage, cost: null };
    },
  );
  try {
    const { data } = z.object({ data: z.array(z.object({
      index: z.number().int().nonnegative(), embedding: VECTOR,
    })).length(texts.length) }).parse(receipt.response);
    data.sort((a, b) => a.index - b.index);
    if (data.some((item, index) => item.index !== index)) throw new Error("Embedding indices do not match inputs");
    return { vectors: data.map((item) => item.embedding), receiptId: receipt.receiptId };
  } catch (error) {
    await rejectReceivedResponse(receipt.receiptId, `unusable embeddings: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Embedding response is unusable for ${subject}: ${String(error).slice(0, 300)}`, receipt.receiptId);
  }
}

// array_send avoids formatting each float as decimal on the database. Its one-dimensional real[]
// payload has a 20-byte header, then a four-byte length and a float4 per coordinate. Keep shapes
// rejected by the text-array reader invalid so the usual replacement path still handles them.
function storedVector(data: Buffer): number[] | null {
  if (data.readInt32BE(0) !== 1 || data.readInt32BE(16) !== 1) return null;
  const vector = new Array<number>(data.readInt32BE(12));
  for (let i = 0; i < vector.length; i++) {
    if (data.readInt32BE(20 + i * 8) === -1) return null;
    vector[i] = data.readFloatBE(24 + i * 8);
  }
  return vector;
}

/** Returns the stored embeddings of report texts, computing and storing the missing ones. */
export async function ensureEmbeddings(items: Array<{ id: string; text: string }>): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (items.length === 0) return out;
  const hashes = new Map(items.map((item) => [item.id, sha256(item.text)]));
  const rows = await sql<{ ref_id: string; text_hash: string; vector: Buffer }[]>`
    SELECT ref_id, text_hash, array_send(vector) AS vector FROM embeddings WHERE kind = 'article' AND model = ${EMBEDDING_MODEL} AND ref_id IN ${sql(items.map((i) => i.id))}`;
  const have = new Map(rows.map((r) => [r.ref_id, r]));
  const missing = items.filter((i) => {
    const h = have.get(i.id);
    const vector = h && h.text_hash === hashes.get(i.id) ? storedVector(h.vector) : null;
    if (vector && VECTOR.safeParse(vector).success) {
      out.set(i.id, vector);
      return false;
    }
    return true;
  });
  for (let i = 0; i < missing.length; i += 10) {
    const batch = missing.slice(i, i + 10);
    const { vectors, receiptId } = await embedBatch(batch.map((b) => b.text.slice(0, 2000)), `article:${batch[0]!.id}`);
    await sql.begin(async (tx) => {
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]!;
        const v = vectors[j]!;
        await tx`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector) VALUES ('article', ${item.id}, ${EMBEDDING_MODEL}, ${hashes.get(item.id)!}, ${v})
                 ON CONFLICT (kind, ref_id, model) DO UPDATE SET text_hash = EXCLUDED.text_hash, vector = EXCLUDED.vector, created_at = now()`;
      }
      await completeReceipt(tx, receiptId);
    });
    for (let j = 0; j < batch.length; j++) out.set(batch[j]!.id, vectors[j]!);
  }
  return out;
}
