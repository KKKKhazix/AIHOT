// Embeddings from any OpenAI-compatible endpoint (EMBEDDING_*): a stored vector of another size is
// computed again, a process with another EMBEDDING_DIMS pays for a request of its own, and with
// EMBEDDING_DIMS=0 the provider picks the size and vectors of different sizes never count as similar.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";

const T = `dims-${tag()}`;
const requests: Array<{ model: string; input: string[]; dimensions?: number }> = [];
// A text carrying this file's tag points along the first axis; the provider's own size is 6.
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as (typeof requests)[number];
  requests.push(body);
  return { data: body.input.map((text, index) => ({ index, embedding: Array.from({ length: body.dimensions ?? 6 }, (_, i) => Number(i === (text.includes(T) ? 0 : 1))) })) };
});
// The embeddings module reads these when it loads.
process.env.EMBEDDING_DIMS = "4";
process.env.EMBEDDING_MODEL = T;
process.env.EMBEDDING_API_KEY = "test-key";
process.env.EMBEDDING_BASE_URL = `${provider.url}/v1`;
const { EMBEDDING_MODEL, ensureEmbeddings } = await import("@aihot/backend/providers/embeddings");
after(async () => {
  await provider.close();
  await closeDb();
});

let serial = 0;
const item = () => ({ id: `${T}-${++serial}`, text: `${T} text ${serial}` });
async function stored(it: { id: string; text: string }, vector: number[]) {
  await sql`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector) VALUES ('article', ${it.id}, ${EMBEDDING_MODEL}, ${sha256(it.text)}, ${vector})`;
}
const persisted = async (id: string) =>
  (await sql<{ vector: number[] }[]>`SELECT vector FROM embeddings WHERE kind = 'article' AND ref_id = ${id} AND model = ${EMBEDDING_MODEL}`)[0]?.vector;
async function freshProcess(dimensions: number, code: string) {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const { ensureEmbeddings } = await import('@aihot/backend/providers/embeddings');
    const { cosine32 } = await import('@aihot/backend/events/recall');
    const { closeDb } = await import('@aihot/backend/db');
    try { ${code} } finally { await closeDb(); }
  `], { env: { ...process.env, EMBEDDING_DIMS: String(dimensions) } });
  return JSON.parse(stdout);
}

for (const oldLength of [2, 8]) test(`a stored vector of ${oldLength} dimensions is computed again at the configured 4`, async () => {
  const it = item();
  await stored(it, Array.from({ length: oldLength }, (_, i) => Number(i === 0)));
  const before = requests.length;
  assert.deepEqual((await ensureEmbeddings([it])).get(it.id), [1, 0, 0, 0], "a stale vector is replaced, never reused or cropped");
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1)!.dimensions, 4);
  assert.deepEqual(await persisted(it.id), [1, 0, 0, 0]);
});

test("a restarted process with other dimensions pays for a request of its own", async () => {
  const it = item();
  const before = requests.length;
  assert.equal((await ensureEmbeddings([it])).get(it.id)!.length, 4);
  const length = await freshProcess(2, `console.log((await ensureEmbeddings([${JSON.stringify(it)}])).get(${JSON.stringify(it.id)}).length);`);
  assert.equal(length, 2);
  assert.deepEqual(requests.slice(before).map((r) => r.dimensions), [4, 2]);
  assert.equal((await persisted(it.id))!.length, 2);
  const receipts = await sql`SELECT DISTINCT logical_key FROM receipts WHERE model = ${EMBEDDING_MODEL} AND subject = ${`article:${it.id}`}`;
  assert.equal(receipts.length, 2);
});

test("the provider's own size keeps stored vectors, asks for no dimensions and never compares sizes", async () => {
  const old = item();
  const fresh = item();
  await stored(old, [1, 0]);
  const before = requests.length;
  const got = await freshProcess(0, `
    const old = Float32Array.from((await ensureEmbeddings([${JSON.stringify(old)}])).get(${JSON.stringify(old.id)}));
    const fresh = Float32Array.from((await ensureEmbeddings([${JSON.stringify(fresh)}])).get(${JSON.stringify(fresh.id)}));
    console.log(JSON.stringify({ old: old.length, fresh: fresh.length, score: cosine32(old, fresh) }));
  `);
  assert.deepEqual(got, { old: 2, fresh: 6, score: 0 }, "the first two coordinates agree, but different sizes are not similar");
  assert.equal(requests.length, before + 1);
  assert.equal(Object.hasOwn(requests.at(-1)!, "dimensions"), false);
});
