import { pollFor } from "./poll.ts";
// Failure modes at the paid response boundary: a fully received invalid response is not an unknown
// outcome; missing/duplicate indices, incomplete dimensions or invalid coordinates cannot enter
// recall; out-of-order valid vectors must stay attached to their original inputs on receipt replay,
// and a batch whose write fails reuses its paid answer instead of buying it again. Once stored, the
// vectors leave the receipt; the same texts needed again after that are bought again, not an error.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { EMBEDDING_DIMS, ensureEmbeddings } from "@aihot/backend/providers/embeddings";
import { ModelOutputError, ReceiptBusyError } from "@aihot/backend/providers/receipts";

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
  const [received] = await sql`SELECT status, completed_at, response FROM receipts WHERE purpose='embedding' AND subject=${`article:${items[0]!.id}`}`;
  assert.equal(received!.status, "received");
  assert.equal(received!.completed_at, null);
  assert.equal(received!.response.data.length, 2, "an unstored answer keeps its vectors");
  const result = await ensureEmbeddings(items);
  assert.deepEqual(result.get(items[0]!.id), vector(1));
  assert.deepEqual(result.get(items[1]!.id), vector(2));
  assert.equal(provider.hits() - before, 1, "retry reuses the paid response");
  assert.equal((await sql`SELECT 1 FROM embeddings WHERE ref_id IN ${sql(items.map((item) => item.id))}`).length, 2);
  const [completed] = await sql`SELECT status, completed_at, response FROM receipts WHERE purpose='embedding' AND subject=${`article:${items[0]!.id}`}`;
  assert.equal(completed!.status, "completed");
  assert.ok(completed!.completed_at);
  assert.equal("data" in completed!.response, false, "stored vectors leave the receipt");
});

test("texts needed again after their stored vectors changed are bought again", async () => {
  const id = tag();
  const item = { id: `${id}-a`, text: `${id} only` };
  answer = { data: [{ index: 0, embedding: vector(3) }], usage: { total_tokens: 3 } };
  const before = provider.hits();
  assert.deepEqual((await ensureEmbeddings([item])).get(item.id), vector(3));
  // The article's text changed and came back: its stored vector no longer matches, the receipt has none.
  await sql`UPDATE embeddings SET text_hash = 'changed' WHERE kind = 'article' AND ref_id = ${item.id}`;
  answer = { data: [{ index: 0, embedding: vector(4) }], usage: { total_tokens: 3 } };
  assert.deepEqual((await ensureEmbeddings([item])).get(item.id), vector(4));
  assert.equal(provider.hits() - before, 2);
  // The first receipt stays as it was; the second purchase is a request of its own.
  const receipts = await sql`SELECT status, attempts, response FROM receipts WHERE purpose='embedding' AND subject=${`article:${item.id}`} ORDER BY id`;
  assert.deepEqual(receipts.map((r) => [r.status, r.attempts, r.response]),
    [["completed", 1, { usage: { total_tokens: 3 } }], ["completed", 1, { usage: { total_tokens: 3 } }]]);
});

test("calls that meet a stored batch's receipt together buy its vectors once", async () => {
  const id = tag();
  const item = { id: `${id}-a`, text: `${id} together` };
  answer = { data: [{ index: 0, embedding: vector(8) }] };
  await ensureEmbeddings([item]);
  await sql`UPDATE embeddings SET text_hash = 'not yet' WHERE kind = 'article' AND ref_id = ${item.id}`;
  answer = { data: [{ index: 0, embedding: vector(9) }] };
  const before = provider.hits();
  // Both find the vector missing before either claims the request.
  const gate = await sql.reserve();
  await gate`BEGIN`;
  await gate`SELECT pg_advisory_xact_lock(hashtext('budget:dashscope')), pg_advisory_xact_lock(hashtext('budget:embedding'))`;
  const calls = [ensureEmbeddings([item]), ensureEmbeddings([item])];
  await pollFor(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'`).length >= 2, "both embedding requests to reach the lock");
  await gate`COMMIT`;
  gate.release();
  const results = await Promise.allSettled(calls);
  assert.equal(provider.hits() - before, 1);
  for (const result of results) {
    if (result.status === "fulfilled") assert.deepEqual(result.value.get(item.id), vector(9));
    else assert.ok(result.reason instanceof ReceiptBusyError, String(result.reason));
  }
});

test("a batch another call stored while this one waited is read from the table, not bought again", async () => {
  const id = tag();
  const item = { id: `${id}-a`, text: `${id} raced` };
  answer = { data: [{ index: 0, embedding: vector(5) }] };
  const before = provider.hits();
  await ensureEmbeddings([item]);
  const [{ text_hash: hash }] = await sql`SELECT text_hash FROM embeddings WHERE kind = 'article' AND ref_id = ${item.id}`;
  // This call finds no vector, then waits to claim the request; the other call stores it meanwhile.
  await sql`UPDATE embeddings SET text_hash = 'not yet' WHERE kind = 'article' AND ref_id = ${item.id}`;
  const gate = await sql.reserve();
  await gate`BEGIN`;
  await gate`SELECT pg_advisory_xact_lock(hashtext('budget:dashscope')), pg_advisory_xact_lock(hashtext('budget:embedding'))`;
  const racing = ensureEmbeddings([item]);
  await pollFor(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'`).length > 0, "embedding request to reach the lock");
  await sql`UPDATE embeddings SET text_hash = ${hash} WHERE kind = 'article' AND ref_id = ${item.id}`;
  answer = { data: [{ index: 0, embedding: vector(6) }] };
  await gate`COMMIT`;
  gate.release();
  assert.deepEqual((await racing).get(item.id), vector(5));
  assert.equal(provider.hits() - before, 1);
  const [receipt] = await sql`SELECT status, attempts FROM receipts WHERE purpose='embedding' AND subject=${`article:${item.id}`}`;
  assert.equal(receipt!.status, "completed");
  assert.equal(receipt!.attempts, 1);
});

test("when another call stored part of a stored batch meanwhile, only the rest is bought", async () => {
  const id = tag();
  const items = [{ id: `${id}-a`, text: `${id} kept` }, { id: `${id}-b`, text: `${id} lacking` }];
  answer = { data: [{ index: 0, embedding: vector(5) }, { index: 1, embedding: vector(6) }] };
  const before = provider.hits();
  await ensureEmbeddings(items);
  const [{ text_hash: hash }] = await sql`SELECT text_hash FROM embeddings WHERE kind = 'article' AND ref_id = ${items[0]!.id}`;
  await sql`UPDATE embeddings SET text_hash = 'not yet' WHERE kind = 'article' AND ref_id IN ${sql(items.map((item) => item.id))}`;
  const gate = await sql.reserve();
  await gate`BEGIN`;
  await gate`SELECT pg_advisory_xact_lock(hashtext('budget:dashscope')), pg_advisory_xact_lock(hashtext('budget:embedding'))`;
  const racing = ensureEmbeddings(items);
  await pollFor(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'`).length > 0, "embedding request to reach the lock");
  await sql`UPDATE embeddings SET text_hash = ${hash} WHERE kind = 'article' AND ref_id = ${items[0]!.id}`;
  answer = { data: [{ index: 0, embedding: vector(7) }] };
  await gate`COMMIT`;
  gate.release();
  const result = await racing;
  assert.deepEqual(result.get(items[0]!.id), vector(5));
  assert.deepEqual(result.get(items[1]!.id), vector(7));
  assert.equal(provider.hits() - before, 2);
  const [first] = await sql`SELECT status, attempts FROM receipts WHERE purpose='embedding' AND subject=${`article:${items[0]!.id}`}`;
  assert.equal(first!.status, "completed");
  assert.equal(first!.attempts, 1);
  const [rest] = await sql`SELECT status FROM receipts WHERE purpose='embedding' AND subject=${`article:${items[1]!.id}`}`;
  assert.equal(rest!.status, "completed");
});
