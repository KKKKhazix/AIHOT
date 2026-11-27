// Text embeddings through receipts, used only for recall. Any OpenAI-compatible /embeddings endpoint
// (EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL); with a DashScope key and nothing else set,
// Aliyun text-embedding-v4 at 1024 dimensions. Without either, recall compares the texts themselves.
// The embeddings table is where vectors are kept: once a batch is stored there, its receipt keeps the
// answer without them, the bulk of a receipt. Recall asks only for texts the table lacks, so a stored
// batch comes up again only through a concurrent call or texts replaced and back (fillBatch).
import { credential, modelCallsEnabled } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { z } from "zod";
import { assertAccepted, completeReceipt, ModelOutputError, ModelUnavailableError, paidRequest, rejectReceivedResponse } from "./receipts.ts";

const own = !!credential("models", "EMBEDDING_API_KEY");
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || (own ? "text-embedding-3-small" : "text-embedding-v4");
/** Requested dimensions, when the provider takes the parameter (0 leaves it to the model). */
export const EMBEDDING_DIMS = Number(process.env.EMBEDDING_DIMS ?? (own ? 0 : 1024));
const SERVICE = own ? "embedding" : "dashscope";
/** A vector of the configured size; a stored one of another size (EMBEDDING_DIMS changed) is computed again. */
const VECTOR = EMBEDDING_DIMS > 0 ? z.array(z.number()).length(EMBEDDING_DIMS) : z.array(z.number()).min(1);

/** Embeddings are paid model calls: MODEL_CALLS_ENABLED=false switches them off like every other call. */
export function embeddingsAvailable(): boolean {
  return modelCallsEnabled() && !!(credential("models", "EMBEDDING_API_KEY") ?? credential("models", "DASHSCOPE_API_KEY"));
}

/** Null vectors: the receipt of a batch already stored, which keeps none (see the top of this file). */
async function embedBatch(texts: string[], subject: string, attemptTag?: string): Promise<{ vectors: number[][] | null; receiptId: number }> {
  if (!modelCallsEnabled()) throw new ModelUnavailableError("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const base = own ? credential("models", "EMBEDDING_BASE_URL") ?? "https://api.openai.com/v1" : credential("models", "DASHSCOPE_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const key = own ? credential("models", "EMBEDDING_API_KEY") : credential("models", "DASHSCOPE_API_KEY");
  if (!key) throw new ModelUnavailableError("EMBEDDING_API_KEY (or DASHSCOPE_API_KEY) missing");
  const request = { service: SERVICE, model: EMBEDDING_MODEL, purpose: "embedding", subject, identity: { model: EMBEDDING_MODEL, dims: EMBEDDING_DIMS, texts: texts.map((t) => sha256(t)) }, requestSummary: { count: texts.length }, attemptTag };
  const call = async () => {
    const res = await fetch(`${base.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, ...(EMBEDDING_DIMS > 0 ? { dimensions: EMBEDDING_DIMS } : {}), encoding_format: "float" }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    assertAccepted(SERVICE, res.status, text);
    let response: unknown;
    try { response = JSON.parse(text); }
    catch { response = { unparsable: text.slice(0, 20000) }; }
    const usage = response && typeof response === "object" && "usage" in response
      ? response.usage as Record<string, unknown> : null;
    return { response, usage, cost: null };
  };
  const receipt = await paidRequest(request, call);
  if (receipt.reused && !(receipt.response && typeof receipt.response === "object" && "data" in receipt.response)) {
    return { vectors: null, receiptId: receipt.receiptId };
  }
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

/**
 * The stored, usable vectors of these items, found by text (hash) and model: the item's own row, else
 * any article's with the same text, which is the same request and the same vector.
 */
async function storedVectors(items: Array<{ id: string }>, hashes: Map<string, string>): Promise<Map<string, number[]>> {
  const ids = items.map((i) => i.id);
  const rows = await sql<{ ref_id: string; text_hash: string; vector: Buffer }[]>`
    SELECT ref_id, text_hash, array_send(vector) AS vector FROM embeddings
    WHERE kind = 'article' AND model = ${EMBEDDING_MODEL} AND text_hash = ANY(${[...new Set(ids.map((id) => hashes.get(id)!))]}::text[])
    ORDER BY created_at DESC`;
  // Only usable rows count, so an unusable one (another size, say) never hides a usable one of the same text.
  const own = new Map<string, number[]>();
  const byText = new Map<string, number[]>();
  for (const row of rows) {
    const vector = storedVector(row.vector);
    if (!vector || !VECTOR.safeParse(vector).success) continue;
    if (row.text_hash === hashes.get(row.ref_id)) own.set(row.ref_id, vector);
    if (!byText.has(row.text_hash)) byText.set(row.text_hash, vector);
  }
  const out = new Map<string, number[]>();
  for (const id of ids) {
    const vector = own.get(id) ?? byText.get(hashes.get(id)!);
    if (vector) out.set(id, vector);
  }
  return out;
}

/**
 * Buys and stores one batch's vectors. A stored batch's receipt (no vectors) means another call stored
 * some or all of them after this one looked, or the texts were replaced since and came back: what the
 * table has now is used and only the rest is asked for. The whole batch again is a new request named
 * after that receipt, which stays as it is, so calls that meet it together still pay once.
 */
async function fillBatch(batch: Array<{ id: string; text: string }>, hashes: Map<string, string>, out: Map<string, number[]>, attemptTag?: string): Promise<void> {
  const { vectors, receiptId } = await embedBatch(batch.map((b) => b.text.slice(0, 2000)), `article:${batch[0]!.id}`, attemptTag);
  if (!vectors) {
    const now = await storedVectors(batch, hashes);
    for (const [id, vector] of now) out.set(id, vector);
    const rest = batch.filter((b) => !now.has(b.id));
    if (rest.length) await fillBatch(rest, hashes, out, rest.length === batch.length ? `again:${receiptId}` : undefined);
    return;
  }
  await sql.begin(async (tx) => {
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j]!;
      await tx`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector) VALUES ('article', ${item.id}, ${EMBEDDING_MODEL}, ${hashes.get(item.id)!}, ${vectors[j]!})
               ON CONFLICT (kind, ref_id, model) DO UPDATE SET text_hash = EXCLUDED.text_hash, vector = EXCLUDED.vector, created_at = now()`;
    }
    await completeReceipt(tx, receiptId, "data");
  });
  for (let j = 0; j < batch.length; j++) out.set(batch[j]!.id, vectors[j]!);
}

/** Returns the stored embeddings of report texts, computing and storing the missing ones. */
export async function ensureEmbeddings(items: Array<{ id: string; text: string }>): Promise<Map<string, number[]>> {
  if (items.length === 0) return new Map();
  const hashes = new Map(items.map((item) => [item.id, sha256(item.text)]));
  const out = await storedVectors(items, hashes);
  const missing = items.filter((i) => !out.has(i.id));
  // One purchase per text: articles sharing it take the vector bought for the first of them.
  const first = new Map<string, string>();
  for (const i of missing) if (!first.has(hashes.get(i.id)!)) first.set(hashes.get(i.id)!, i.id);
  const buy = missing.filter((i) => first.get(hashes.get(i.id)!) === i.id);
  for (let i = 0; i < buy.length; i += 10) await fillBatch(buy.slice(i, i + 10), hashes, out);
  for (const i of missing) {
    const vector = out.get(first.get(hashes.get(i.id)!)!);
    if (vector) out.set(i.id, vector);
  }
  return out;
}
