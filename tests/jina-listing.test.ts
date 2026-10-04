// A listing read through Jina is a paid request of its own on every fetch, with its own receipt: a read
// whose outcome is unknown is never sent again and is left to ops.recover, the next fetch reads the
// listing afresh, and a page received before a storage failure stays on its receipt.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { previewStoredSource } from "@aihot/backend/admin/sources";

const T = tag();
const SOURCE = `test-jina-listing-${T}`;

// Jina, answered here: in "drop" mode the connection closes after the request arrived, so whether it
// was billed is unknown.
let mode: "drop" | "page" = "drop";
let hits = 0;
const jina = http.createServer((req, res) => {
  if (req.headers["x-return-format"] === "html") {
    res.writeHead(200, { "content-type": "text/plain" });
    return void res.end(`<html><body><article><a href="/blog/rendered-${T}"><time datetime="2026-09-23">September 23, 2026</time><h2>Rendered ${T}</h2></a></article></body></html>`);
  }
  hits += 1;
  if (mode === "drop") return void req.socket.destroy();
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`Title: News\nURL Source: https://example.org/news/\n\nMarkdown Content:\n# [Post ${hits} ${T}](https://example.org/news/post-${hits}-${T})\n`);
});
await new Promise<void>((resolve) => jina.listen(0, "127.0.0.1", () => resolve()));
process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  // These reads come faster than the per-minute Jina budget the migrations seed.
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 1000, per_day = 1000 WHERE service = 'jina'`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config, cursor)
    VALUES (${SOURCE}, 'Jina listing', 'web_list', 'T2', 'editorial', '2100-01-01',
            ${sql.json({ url: "https://r.jina.ai/https://example.org/news/", allowUrlPrefixes: ["https://example.org/news/"] })},
            ${sql.json({ initializedAt: new Date().toISOString() })})`;
});
after(async () => {
  jina.close();
  await stopBoss();
  await closeDb();
});

const receipts = () => sql<{ status: string; attempts: number; text: string | null }[]>`
  SELECT status, attempts, response->>'text' AS text FROM receipts WHERE subject = ${`source:${SOURCE}`} ORDER BY id`;

test("a listing read whose outcome is unknown is not sent again; each later fetch is a paid read of its own", async () => {
  const lost = await collectSource(SOURCE, { force: true });
  assert.equal(lost.status, "failed");
  assert.equal(hits, 1);
  assert.deepEqual((await receipts()).map((r) => r.status), ["unknown"]);

  // The next fetch does not wait for that receipt: it is a new request with a receipt of its own.
  mode = "page";
  const next = await collectSource(SOURCE, { force: true });
  assert.equal(next.status, "ok", next.error ?? "");
  assert.equal(next.created, 1);
  assert.equal(hits, 2);
  assert.deepEqual((await receipts()).map((r) => r.status), ["unknown", "received"], "the unknown receipt is left to ops.recover");

  // ops.recover releases it once and nothing sends it again; the fetch after a received page reads the
  // listing afresh instead of that page.
  await autoReleaseUnknownReceipts(Date.now() + 31 * 60_000);
  const again = await collectSource(SOURCE, { force: true });
  assert.equal(again.status, "ok", again.error ?? "");
  assert.equal(again.created, 1);
  assert.equal(hits, 3);
  assert.deepEqual((await receipts()).map((r) => [r.status, r.attempts]), [["failed", 1], ["received", 1], ["received", 1]]);
});

test("a listing parsed with selectors is read from Jina as rendered HTML, dates included", async () => {
  const id = `${SOURCE}-html`;
  // Added before the post's date, so a regular run keeps it.
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config, cursor)
    VALUES (${id}, 'Jina HTML listing', 'web_list', 'T1', 'editorial', '2100-01-01',
            ${sql.json({ url: "https://r.jina.ai/https://example.org/", baseUrl: "https://example.org", parseMode: "html", itemSelector: "article",
              titleSelector: "h2", publishedAtSelector: "time", allowUrlPrefixes: ["https://example.org/blog/"] })},
            ${sql.json({ initializedAt: "2026-09-01T00:00:00.000Z" })})`;
  const run = await collectSource(id, { force: true });
  assert.equal(run.status, "ok", run.error ?? "");
  const [post] = await sql<{ title: string; published_at: Date }[]>`SELECT title, published_at FROM articles WHERE source_id = ${id}`;
  assert.equal(post?.title, `Rendered ${T}`);
  assert.equal(post?.published_at.toISOString(), "2026-09-23T00:00:00.000Z");
});

// A paid page can arrive before a database error: it is saved on the fetch's receipt before anything is
// stored, so the failure loses nothing that was paid for, and the next fetch reads the listing as usual.
test("a listing page received before a storage failure stays on its receipt", async () => {
  mode = "page";
  const before = hits;
  await sql.unsafe(`CREATE FUNCTION fail_listing_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id = '${SOURCE}' THEN RAISE EXCEPTION 'injected listing storage failure'; END IF;
    RETURN NEW; END $$`);
  await sql`CREATE TRIGGER fail_listing_storage BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION fail_listing_storage()`;
  try { assert.equal((await collectSource(SOURCE)).status, "failed"); }
  finally { await sql`DROP TRIGGER fail_listing_storage ON articles`; await sql`DROP FUNCTION fail_listing_storage()`; }
  assert.equal(hits, before + 1);
  const kept = (await receipts()).at(-1)!;
  assert.equal(kept.status, "received");
  assert.ok(kept.text?.includes(`post-${before + 1}-${T}`), "the page is on the receipt");
  const next = await collectSource(SOURCE);
  assert.equal(next.status, "ok", next.error ?? "");
  assert.equal(next.created, 1);
  assert.equal(hits, before + 2);
});

test("each admin preview is a paid read of its own", async () => {
  const before = hits;
  assert.equal((await previewStoredSource(SOURCE))!.count, 1);
  assert.equal((await previewStoredSource(SOURCE))!.count, 1);
  assert.equal(hits, before + 2);
});
