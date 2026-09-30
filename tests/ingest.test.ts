// Malformed external batches are rejected before any source or article is written; ordinary
// batches retain their missing-field skips, URL deduplication and isolated-source defaults.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { registerIngest } from "../apps/api/src/routes/ingest.ts";

const T = tag();
const token = "ingest-test-token-0123456789";
const previousToken = process.env.INGEST_TOKEN;
process.env.INGEST_TOKEN = token;
const app = Fastify();
registerIngest(app);
let request = 0;

async function push(body: unknown) {
  request += 1;
  return app.inject({
    method: "POST", url: "/api/ingest/items", remoteAddress: `192.0.2.${request}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
  if (previousToken === undefined) delete process.env.INGEST_TOKEN;
  else process.env.INGEST_TOKEN = previousToken;
});

const malformed = [null, "not an item", 42, true, []];

test("non-object request bodies return 400", async () => {
  for (const body of malformed) {
    const response = await push(body);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().ok, false);
  }
});

test("non-object items return 400 without creating a source", async (t) => {
  for (const [index, item] of malformed.entries()) {
    await t.test(`item ${JSON.stringify(item)}`, async () => {
      const sourceId = `ingest-invalid-${T}-${index}`;
      const response = await push({ sourceId, items: [item] });
      const sources = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
      assert.equal(sources.length, 0, "invalid input must not create a source");
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().ok, false);
    });
  }
});

test("a malformed item after a valid one rejects the batch before either is stored", async (t) => {
  for (const [index, item] of malformed.entries()) {
    await t.test(`later item ${JSON.stringify(item)}`, async () => {
      const sourceId = `ingest-mixed-${T}-${index}`;
      const url = `https://example.org/ingest-mixed-${T}-${index}`;
      const response = await push({ sourceId, items: [{ title: "Valid article", url }, item] });
      const sources = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
      const articles = await sql`SELECT id FROM articles WHERE url = ${url}`;
      assert.equal(sources.length, 0, "validate the whole batch before creating its source");
      assert.equal(articles.length, 0, "a valid earlier item must not be partially ingested");
      assert.equal(response.statusCode, 400, response.body);
    });
  }
});

test("rejecting a malformed batch does not update an existing source", async () => {
  const sourceId = `ingest-existing-${T}`;
  const lastOk = new Date("2020-01-01T00:00:00Z");
  await sql`INSERT INTO sources (id, name, kind, last_ok_at)
            VALUES (${sourceId}, 'Existing ingest source', 'external', ${lastOk})`;
  const response = await push({ sourceId, items: [null] });
  const [source] = await sql`SELECT last_ok_at, last_fetch_at FROM sources WHERE id = ${sourceId}`;
  assert.equal(source!.last_ok_at.toISOString(), lastOk.toISOString());
  assert.equal(source!.last_fetch_at, null);
  assert.equal(response.statusCode, 400, response.body);
});

test("valid batches retain skips, deduplication, backfill and isolated-source defaults", async () => {
  const sourceId = `ingest-valid-${T}`;
  const url = `https://example.org/ingest-valid-${T}`;
  const response = await push({
    sourceId, sourceName: "Test crawler",
    items: [
      {}, { title: "Missing URL" }, { url }, { title: "Invalid URL", url: "not a URL" },
      { title: " First title ", url, author: "Test author", publishedAt: "2020-01-01T00:00:00Z", raw: { _aihot: { backfill: true } } },
      { title: "Duplicate URL", url },
    ],
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, created: 1 });
  const [source] = await sql`SELECT name, kind, participation_mode FROM sources WHERE id = ${sourceId}`;
  assert.deepEqual({ ...source }, { name: "Test crawler", kind: "external", participation_mode: "isolated" });
  const articles = await sql`SELECT title, author, backfill FROM articles WHERE source_id = ${sourceId}`;
  assert.deepEqual(articles.map((row) => ({ ...row })), [{ title: "First title", author: "Test author", backfill: true }]);
  const repeated = await push({ sourceId, items: [{ title: "First title", url, author: "Test author", publishedAt: "2020-01-01T00:00:00Z", raw: { _aihot: { backfill: true } } }] });
  assert.deepEqual(repeated.json(), { ok: true, created: 0 });
});

test("empty and oversized batches are rejected before creating a source", async () => {
  const sourceId = `ingest-size-${T}`;
  for (const [items, status] of [[[], 400], [Array.from({ length: 51 }, () => ({})), 413]] as const) {
    const response = await push({ sourceId, items });
    assert.equal(response.statusCode, status, response.body);
  }
  assert.equal((await sql`SELECT id FROM sources WHERE id = ${sourceId}`).length, 0);
});


test("paused sources reject pushes without recording success, then accept after resuming", async () => {
  const sourceId = `ingest-paused-${T}`;
  const lastOk = new Date("2020-01-01T00:00:00Z");
  await sql`INSERT INTO sources (id, name, kind, enabled, health, last_ok_at)
            VALUES (${sourceId}, 'Paused source', 'external', false, 'paused', ${lastOk})`;
  const body = { sourceId, items: [{ title: "Report", url: `https://example.org/${sourceId}` }] };
  const paused = await push(body);
  assert.equal(paused.statusCode, 409, paused.body);
  const [source] = await sql`SELECT last_ok_at FROM sources WHERE id = ${sourceId}`;
  assert.equal(source!.last_ok_at.toISOString(), lastOk.toISOString());
  assert.equal((await sql`SELECT id FROM articles WHERE source_id = ${sourceId}`).length, 0);
  await sql`UPDATE sources SET enabled = true WHERE id = ${sourceId}`;
  const resumed = await push(body);
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.deepEqual(resumed.json(), { ok: true, created: 1 });
});
