// Storage transport must preserve every float32 bit used by recall, including signed zero and
// subnormals. Empty, nested, null-containing and non-finite vectors must still be replaced; a
// matching id with another model or text hash must never suppress a paid request for the right text.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";

const T = `storage-${tag()}`;
const replacement = [1, 0, 0, 0];
const provider = await stub((_hit, req) => ({ data: (JSON.parse(req.body).input as string[])
  .map((_text, index) => ({ index, embedding: replacement })) }));
process.env.EMBEDDING_MODEL = T;
process.env.EMBEDDING_DIMS = "0";
process.env.EMBEDDING_API_KEY = "test-key";
process.env.EMBEDDING_BASE_URL = `${provider.url}/v1`;
const { ensureEmbeddings } = await import("@aihot/backend/providers/embeddings");
after(async () => { await provider.close(); await closeDb(); });

const bits = (vector: number[]) => Buffer.from(Float32Array.from(vector).buffer);
let serial = 0;
const item = () => ({ id: `${T}-${++serial}`, text: `${T} text ${serial}` });

async function store(it: { id: string; text: string }, vector: string, model = T, hash = sha256(it.text)) {
  await sql`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector)
    VALUES ('article', ${it.id}, ${model}, ${hash}, ${vector}::real[])`;
}

test("stored float32 coordinates retain their bits without asking the provider", async () => {
  const it = item();
  const values = [0, -0, 1, -1, 0.1, -0.1, 2 ** -149, -(2 ** -149), 2 ** -126, (2 - 2 ** -23) * 2 ** 127];
  // Cover every finite exponent with both signs, and values whose decimal representation rounds.
  const raw = Buffer.alloc(4);
  for (let exponent = 0; exponent < 255; exponent++) {
    raw.writeUInt32BE((exponent * 0x800000 + 0x456789) >>> 0);
    values.push(raw.readFloatBE(), -raw.readFloatBE());
  }
  await store(it, `{${values.map(v => Object.is(v, -0) ? "-0" : String(v)).join(",")}}`);
  const [stored] = await sql<{ vector: number[] }[]>`SELECT vector FROM embeddings WHERE ref_id = ${it.id}`;
  const before = provider.hits();
  const result = (await ensureEmbeddings([it])).get(it.id)!;
  assert.deepEqual(bits(result), bits(stored!.vector));
  assert.deepEqual(bits(result), bits(values));
  assert.equal(provider.hits(), before);
});

test("unusable stored vectors still require a valid replacement", async () => {
  for (const vector of ["{}", "{{1,0},{0,1}}", "{1,NULL,0,0}", "{NaN,0,0,0}", "{Infinity,0,0,0}", "{-Infinity,0,0,0}", "[0:3]={1,0,0,0}"]) {
    const it = item();
    await store(it, vector);
    const before = provider.hits();
    assert.deepEqual((await ensureEmbeddings([it])).get(it.id), replacement, vector);
    assert.equal(provider.hits(), before + 1, vector);
  }
});

test("stored text hashes and model identities are still required for reuse", async () => {
  for (const mismatch of ["hash", "model"]) {
    const it = item();
    await store(it, "{0,1,0,0}", mismatch === "model" ? `${T}-other` : T, mismatch === "hash" ? sha256("different") : sha256(it.text));
    const before = provider.hits();
    assert.deepEqual((await ensureEmbeddings([it])).get(it.id), replacement);
    assert.equal(provider.hits(), before + 1);
  }
});
