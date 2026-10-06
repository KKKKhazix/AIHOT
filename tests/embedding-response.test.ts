// Failure modes at the paid response boundary: a fully received invalid response is not an unknown
// outcome; missing/duplicate indices, incomplete dimensions or invalid coordinates cannot enter
// recall; out-of-order valid vectors must stay attached to their original inputs on receipt replay,
// and a batch whose write fails reuses its paid answer instead of buying it again.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { EMBEDDING_DIMS, ensureEmbeddings } from "@aihot/backend/providers/embeddings";
import { ModelOutputError } from "@aihot/backend/providers/llm";

let answer: unknown;
const provider = await stub(() => answer);
process.env.DASHSCOPE_BASE_URL = `${provider.url}/v1`;
process.env.DASHSCOPE_API_KEY = "test-key";
after(async () => { await provider.close(); await closeDb(); });
const vector = (n: number) => Array.from({ length: EMBEDDING_DIMS }, () => n);

test("unusable embedding responses retain the paid answer and never write partial vectors", async () => {
  const invalid = [null, "not a response object", { data: [] },
    { data: [{ index: 0, embedding: vector(1) }, { index: 0, embedding: vector(2) }] },
    { data: [{ index: 0, embedding: vector(1) }, { index: 1, embedding: [2] }] },
    { data: [{ index: 0, embedding: vector(1) }, { index: 1, embedding: [...vector(2).slice(1), null] }] }];
  for (const response of invalid) {
    const id = tag();
    const items = [{ id: `${id}-a`, text: `${id} first` }, { id: `${id}-b`, text: `${id} second` }];
    answer = response;
    await assert.rejects(ensureEmbeddings(items), ModelOutputError);
    const [receipt] = await sql`SELECT status, response FROM receipts WHERE subject=${`article:${items[0]!.id}`}`;
    assert.equal(receipt!.status, "failed");
    assert.notEqual(receipt!.response, undefined);
    assert.equal((await sql`SELECT 1 FROM embeddings WHERE ref_id IN ${sql(items.map((item) => item.id))}`).length, 0);
  }
});

test("out-of-order embeddings keep their inputs, and a rolled-back batch reuses its paid receipt", async () => {
  const id = tag();
  const items = [{ id: `${id}-a`, text: `${id} first` }, { id: `${id}-b`, text: `${id} second` }];
  answer = { data: [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) }] };
  const before = provider.hits();
  await sql.unsafe(`CREATE FUNCTION test_embedding_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.ref_id = '${items[1]!.id}' THEN RAISE EXCEPTION 'intentional embedding rollback'; END IF;
      RETURN NEW;
    END $$`);
  await sql.unsafe(`CREATE TRIGGER test_embedding_rollback BEFORE INSERT OR UPDATE ON embeddings
    FOR EACH ROW EXECUTE FUNCTION test_embedding_rollback()`);
  try {
    await assert.rejects(ensureEmbeddings(items), /intentional embedding rollback/);
  } finally {
    await sql.unsafe("DROP TRIGGER test_embedding_rollback ON embeddings");
    await sql.unsafe("DROP FUNCTION test_embedding_rollback()");
  }
  assert.equal(provider.hits() - before, 1);
  assert.equal((await sql`SELECT 1 FROM embeddings WHERE ref_id IN ${sql(items.map((item) => item.id))}`).length, 0);
  const [received] = await sql`SELECT status, completed_at FROM receipts WHERE purpose='embedding' AND subject=${`article:${items[0]!.id}`}`;
  assert.equal(received!.status, "received");
  assert.equal(received!.completed_at, null);
  const result = await ensureEmbeddings(items);
  assert.deepEqual(result.get(items[0]!.id), vector(1));
  assert.deepEqual(result.get(items[1]!.id), vector(2));
  assert.equal(provider.hits() - before, 1, "retry reuses the paid response");
  assert.equal((await sql`SELECT 1 FROM embeddings WHERE ref_id IN ${sql(items.map((item) => item.id))}`).length, 2);
  const [completed] = await sql`SELECT status, completed_at FROM receipts WHERE purpose='embedding' AND subject=${`article:${items[0]!.id}`}`;
  assert.equal(completed!.status, "completed");
  assert.ok(completed!.completed_at);
});
