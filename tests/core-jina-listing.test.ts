// A listing read through Jina is one paid request per fetch round (security audit S4, 2026-09-28): when
// the outcome of a read is unknown, the next fetches do not pay again; ops.recover releases the receipt
// once and only then is it read again, under the same receipt. A received page ends the round, so the
// fetch after it reads the listing afresh (#1452).
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
let mode: "drop" | "page" | "invalid" = "drop";
let hits = 0;
const jina = http.createServer((req, res) => {
  if (req.headers["x-return-format"] === "html") {
    res.writeHead(200, { "content-type": "text/plain" });
    return void res.end(`<html><body><article><a href="/blog/rendered-${T}"><time datetime="2026-09-23">September 23, 2026</time><h2>Rendered ${T}</h2></a></article></body></html>`);
  }
  hits += 1;
  if (mode === "drop") return void req.socket.destroy();
  res.writeHead(200, { "content-type": "text/plain" });
  if (mode === "invalid") return void res.end("Upstream temporarily unavailable");
  res.end(`Title: News\nURL Source: https://example.org/news/\n\nMarkdown Content:\n# [Post ${hits} ${T}](https://example.org/news/post-${hits}-${T})\n`);
});
await new Promise<void>((resolve) => jina.listen(0, "127.0.0.1", () => resolve()));
process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'jina'`;
  await sql`UPDATE budgets SET per_minute=1000, per_hour=1000, per_day=1000 WHERE service='jina'`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config, cursor)
    VALUES (${SOURCE}, 'Jina listing', 'web_list', 'T2', 'editorial', '2100-01-01',
            ${sql.json({ url: "https://r.jina.ai/https://example.org/news/", allowUrlPrefixes: ["https://example.org/news/"] })},
            ${sql.json({ initializedAt: new Date().toISOString() })})`;
});
after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute=${savedBudget.per_minute}, per_hour=${savedBudget.per_hour}, per_day=${savedBudget.per_day} WHERE service='jina'`;
  jina.close();
  await stopBoss();
  await closeDb();
});

const receipts = () => sql<{ id: number; status: string; attempts: number }[]>`
  SELECT id, status, attempts FROM receipts WHERE subject = ${`source:${SOURCE}`} ORDER BY id`;
const round = async () => (await sql<{ round: string | null }[]>`SELECT cursor->>'jinaListingRound' AS round FROM sources WHERE id = ${SOURCE}`)[0]!.round;

test("a listing read with an unknown outcome is not paid for again until it is released", async () => {
  const lost = await collectSource(SOURCE, { force: true });
  assert.equal(lost.status, "failed");
  assert.equal(hits, 1);
  const [first] = await receipts();
  assert.equal(first!.status, "unknown");

  // The next scheduled fetch comes back to the same receipt instead of sending the request again.
  assert.equal((await collectSource(SOURCE, { force: true })).status, "failed");
  assert.equal(hits, 1, "no second paid request");
  assert.equal((await receipts()).length, 1);
  assert.ok(await round(), "the round stays open while its read is unresolved");

  // Released once by ops.recover, the same round is read again, under the same receipt.
  mode = "page";
  await autoReleaseUnknownReceipts(Date.now() + 31 * 60_000);
  const recovered = await collectSource(SOURCE, { force: true });
  assert.equal(recovered.status, "ok", recovered.error ?? "");
  assert.equal(recovered.created, 1);
  assert.equal(hits, 2);
  const after = await receipts();
  assert.deepEqual(after.map((r) => [r.id, r.attempts]), [[first!.id, 2]]);
  assert.equal(await round(), null, "a received page ends the round");

  // A later fetch is a new round: the listing is read afresh, not served from the earlier page.
  const next = await collectSource(SOURCE, { force: true });
  assert.equal(next.status, "ok", next.error ?? "");
  assert.equal(next.created, 1);
  assert.equal(hits, 3);
  assert.equal((await receipts()).length, 2);
});

test("a listing parsed with selectors is read from Jina as rendered HTML, dates included", async () => {
  const id = `${SOURCE}-html`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config, cursor)
    VALUES (${id}, 'Jina HTML listing', 'web_list', 'T1', 'editorial', '2100-01-01',
            ${sql.json({ url: "https://r.jina.ai/https://example.org/", baseUrl: "https://example.org", parseMode: "html", itemSelector: "article",
              titleSelector: "h2", publishedAtSelector: "time", allowUrlPrefixes: ["https://example.org/blog/"] })},
            ${sql.json({ initializedAt: new Date().toISOString() })})`;
  const run = await collectSource(id, { force: true });
  assert.equal(run.status, "ok", run.error ?? "");
  const [post] = await sql<{ title: string; published_at: Date }[]>`SELECT title, published_at FROM articles WHERE source_id = ${id}`;
  assert.equal(post?.title, `Rendered ${T}`);
  assert.equal(post?.published_at.toISOString(), "2026-09-23T00:00:00.000Z");
});

// A paid rendering can arrive before a database error. Retrying persistence must reuse that page;
// an unusable rendering, however, must not trap future collection on the same broken response.
test("a received listing survives storage failure, while invalid renderings can refresh", async () => {
  mode = "page";
  const before = hits;
  await sql.unsafe(`CREATE FUNCTION fail_listing_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id = '${SOURCE}' THEN RAISE EXCEPTION 'injected listing storage failure'; END IF;
    RETURN NEW; END $$`);
  await sql`CREATE TRIGGER fail_listing_storage BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION fail_listing_storage()`;
  try { assert.equal((await collectSource(SOURCE)).status, "failed"); }
  finally { await sql`DROP TRIGGER fail_listing_storage ON articles`; await sql`DROP FUNCTION fail_listing_storage()`; }
  assert.equal(hits, before + 1);
  const recovered = await collectSource(SOURCE);
  assert.equal(recovered.status, "ok", recovered.error ?? "");
  assert.equal(recovered.created, 1);
  assert.equal(hits, before + 1, "the received page is not bought again after a storage error");
  assert.equal(await round(), null);
  mode = "invalid";
  assert.equal((await collectSource(SOURCE)).status, "failed");
  mode = "page";
  assert.equal((await collectSource(SOURCE)).status, "ok", "an unusable rendering must allow a fresh page next run");
});

test("successful admin previews finish their read without waiting for material storage", async () => {
  const before = hits;
  assert.equal((await previewStoredSource(SOURCE))!.count, 1);
  assert.equal((await previewStoredSource(SOURCE))!.count, 1);
  assert.equal(hits, before + 2);
  assert.equal(await round(), null, "preview has no material commit to finish its receipt round");
});
