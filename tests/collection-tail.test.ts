// A regular run keeps every entry published since its source was added, past the first 60: the cursor (an
// RSS validator) moves past the whole listing. The dated archive from before comes in only through the
// bounded first import; the detail budget and the success cursor keep their bounds.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

type Kind = "rss" | "json_list" | "web_list";
interface Item { url: string; title: string; date: string | null; summary: string; category?: string }
interface Listing {
  kind: Kind;
  items: Item[];
  version: number;
  requests: Array<{ etag?: string; status: number }>;
}
const T = tag();
const listings = new Map<string, Listing>();
const detailRequests: string[] = [];
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  const listing = listings.get(path);
  if (!listing) {
    if (!path.startsWith("/article/")) { res.writeHead(404); res.end(); return; }
    detailRequests.push(path);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><h1>详细标题 ${escape(path)}</h1><time datetime="${new Date().toISOString()}"></time></body></html>`);
    return;
  }
  const etag = `"v${listing.version}"`;
  const status = listing.kind === "rss" && req.headers["if-none-match"] === etag ? 304 : 200;
  listing.requests.push({ etag: req.headers["if-none-match"], status });
  if (status === 304) { res.writeHead(304, { etag }); res.end(); return; }
  if (listing.kind === "json_list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listing.items));
  } else if (listing.kind === "web_list") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(listing.items.map(i => `<article><a href="${escape(i.url)}">${escape(i.title)}</a>${i.date ? `<time datetime="${i.date}"></time>` : ""}</article>`).join(""));
  } else {
    res.writeHead(200, { "content-type": "application/rss+xml", etag });
    res.end(`<rss version="2.0"><channel><title>测试订阅</title>${listing.items.map(i =>
      `<item><title>${escape(i.title)}</title><link>${escape(i.url)}</link>${i.date ? `<pubDate>${new Date(i.date).toUTCString()}</pubDate>` : ""}<description>${escape(i.summary)}</description><category>${escape(i.category ?? "keep")}</category></item>`).join("")}</channel></rss>`);
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

function items(name: string, count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `${base}/article/${T}-${name}/${i}`, title: `测试文章 ${name} ${i}`, date: new Date(Date.now() - i * 1000).toISOString(), summary: `摘要 ${name} ${i}`,
  }));
}
async function source(name: string, kind: Kind, rows: Item[], extra: Record<string, unknown> = {}, initialized = true) {
  const id = `tail-${T}-${name}`;
  const path = `/listing/${id}`;
  const listing: Listing = { kind, items: rows, version: 1, requests: [] };
  listings.set(path, listing);
  const mapping = kind === "rss" ? { feedUrl: base + path } : kind === "json_list"
    ? { url: base + path, titlePaths: ["title"], urlTemplate: "{raw:url}", publishedAtPath: "date", summaryPaths: ["summary"], summaryIsBody: true }
    : { url: base + path, itemSelector: "article", linkSelector: "a", publishedAtSelector: "time" };
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'列表尾部测试',${kind},${sql.json({ ...mapping, ...extra } as never)},'T1','editorial',
      ${initialized ? sql.json({ initializedAt: new Date().toISOString() }) : null},'2100-01-01')`;
  return { id, listing };
}
const count = async (id: string) => (await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${id}`)[0]!.n as number;
const cursor = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;
const jobs = async (id: string) => (await sql`SELECT count(*)::int AS n FROM pgboss.job j JOIN articles a ON a.id=j.data->>'articleId' WHERE a.source_id=${id}`)[0]!.n as number;
const revisions = async (id: string) => (await sql`SELECT count(*)::int AS n FROM article_revisions r JOIN articles a ON a.id=r.article_id WHERE a.source_id=${id}`)[0]!.n as number;

test("the 61st entry of a known feed is stored before its validator answers 304", async () => {
  const { id, listing } = await source("rss", "rss", items("rss", 61));
  const first = await collectSource(id);
  assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", 61, 61, 0]);
  assert.equal(await count(id), 61);
  assert.equal((await cursor(id)).rss.etag, '"v1"');
  const beforeJobs = await jobs(id);
  const second = await collectSource(id);
  assert.deepEqual([second.status, second.found, second.created, second.revised], ["ok", 0, 0, 0]);
  assert.deepEqual(listing.requests, [{ etag: undefined, status: 200 }, { etag: '"v1"', status: 304 }]);
  assert.equal(await count(id), 61);
  assert.equal(await revisions(id), 61);
  assert.equal(await jobs(id), beforeJobs);
});

for (const size of [0, 1, 59, 60, 61, 100]) {
  test(`a regular JSON run keeps all ${size} entries it was given`, async () => {
    const { id } = await source(`size-${size}`, "json_list", items(`size-${size}`, size));
    const result = await collectSource(id);
    assert.deepEqual([result.status, result.found, result.created, result.revised], ["ok", size, size, 0]);
    assert.equal(await count(id), size);
  });
}

test("a listing longer than a query's parameter limit is still deduplicated and its new tail stored", async () => {
  const known: Item = { url: `${base}/${T}`, title: "Large", date: null, summary: "" };
  const tail = { ...known, url: known.url + "-tail", title: "Tail" };
  const { id, listing } = await source("large", "json_list", [known]);
  assert.equal((await collectSource(id)).created, 1);
  listing.items = [...Array<Item>(65_535).fill(known), tail];
  assert.ok(Buffer.byteLength(JSON.stringify(listing.items)) < 8 * 1024 * 1024, "the response stays within the 8 MiB limit");
  const result = await collectSource(id);
  assert.deepEqual(result, { sourceId: id, status: "ok", found: 65_536, created: 1, revised: 0 });
  assert.equal(await count(id), 2);
  assert.equal(await revisions(id), 2);
  assert.equal(await jobs(id), 2);
  assert.deepEqual(await collectSource(id), { sourceId: id, status: "ok", found: 65_536, created: 0, revised: 0 });
  assert.equal(await revisions(id), 2);
  assert.equal(await jobs(id), 2);
});

test("with the first 60 known, the tail is still created and revised, and queued for processing once", async () => {
  const rows = items("json-tail", 61);
  const { id, listing } = await source("json-tail", "json_list", rows.slice(0, 60));
  assert.equal((await collectSource(id)).created, 60);
  listing.items = rows;
  const added = await collectSource(id);
  assert.deepEqual([added.status, added.found, added.created, added.revised], ["ok", 61, 1, 0]);
  const [tail] = await sql`SELECT id,revision FROM articles WHERE url=${rows[60]!.url}`;
  assert.equal(tail!.revision, 1);
  // The first job is done: the revision must queue processing again.
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=${tail!.id}`;
  await sql`UPDATE articles SET processing_queued_at=NULL WHERE id=${tail!.id}`;
  rows[60] = { ...rows[60]!, title: "尾部修订后的标题", summary: "尾部修订后的正文" };
  const revised = await collectSource(id);
  assert.deepEqual([revised.status, revised.created, revised.revised], ["ok", 0, 1]);
  const [saved] = await sql`SELECT title,body_text,revision,processing_queued_at FROM articles WHERE id=${tail!.id}`;
  assert.deepEqual([saved!.title, saved!.body_text, saved!.revision], [rows[60]!.title, rows[60]!.summary, 2]);
  assert.ok(saved!.processing_queued_at);
  const [job] = await sql`SELECT name FROM pgboss.job WHERE data->>'articleId'=${tail!.id}`;
  assert.equal(job!.name, QUEUES.analyze);
  const beforeJobs = await jobs(id);
  assert.deepEqual(await collectSource(id), { sourceId: id, status: "ok", found: 61, created: 0, revised: 0 });
  assert.equal(await count(id), 61);
  assert.equal(await revisions(id), 62);
  assert.equal(await jobs(id), beforeJobs);
});

for (const reverse of [false, true]) {
  test(`a web list of 100 entries loses none, ${reverse ? "oldest" : "newest"} first`, async () => {
    const rows = items(`web-${reverse}`, 100);
    if (reverse) rows.reverse();
    const { id, listing } = await source(`web-${reverse}`, "web_list", rows, { sortByPublishedAt: reverse });
    const result = await collectSource(id);
    assert.deepEqual([result.status, result.found, result.created], ["ok", 100, 100]);
    assert.equal(await count(id), 100);
    assert.equal(listing.requests.length, 1, "the tail costs no extra listing request");
  });
}

test("the first import keeps its count and age limits; later runs take what was published since, and undated entries, before accepting 304", async () => {
  const rows = items("initial", 100);
  rows[0]!.date = new Date(Date.now() - 400 * 86400000).toISOString();
  // Past the import's count: published days before the source is added, just within the stale window, undated.
  for (const row of rows.slice(90, 95)) row.date = new Date(Date.now() - 3 * 86400000).toISOString();
  rows[95]!.date = new Date(Date.now() - 47 * 3600000).toISOString();
  for (const row of rows.slice(96)) row.date = null;
  const { id, listing } = await source("initial", "rss", rows, { _aihot: { initialBackfillLimit: 7, initialBackfillMonths: 12 } }, false);
  assert.equal((await collectSource(id)).created, 7);
  assert.equal((await cursor(id)).rss, undefined);
  const imported = await sql`SELECT url,backfill,backfill_reason FROM articles WHERE source_id=${id}`;
  assert.ok(imported.every(a => a.backfill && a.backfill_reason === "first-import"));
  assert.ok(!imported.some(a => a.url === rows[0]!.url), "an entry past the age limit takes no place in the first import");
  const second = await collectSource(id);
  assert.deepEqual([second.status, second.found, second.created, second.revised], ["ok", 100, 87, 0]);
  const stored = await sql`SELECT url,backfill_reason FROM articles WHERE source_id=${id}`;
  const urls = new Set(stored.map(a => a.url));
  assert.deepEqual([0, 90, 91, 92, 93, 94].filter(i => urls.has(rows[i]!.url)), [], "what was published before the source was added stays out");
  assert.ok(urls.has(rows[95]!.url) && urls.has(rows[89]!.url), "what was published since is kept, however far down the listing");
  assert.deepEqual(stored.filter(a => rows.slice(96).some(r => r.url === a.url)).map(a => a.backfill_reason), Array(4).fill("unknown-publication-time"),
    "undated entries are kept and wait for a date");
  assert.equal(await count(id), 94);
  assert.equal((await collectSource(id)).found, 0);
  assert.deepEqual(listing.requests.map(r => r.status), [200, 200, 304]);
  assert.equal(listing.requests[1]!.etag, undefined);
});

// A corrected listing can reveal that an existing undated item is old. The archive admission rule
// must still reject a never-seen old item, while allowing metadata repair of the existing identity.
for (const kind of ["rss", "web_list", "json_list"] as const) test(`${kind} repairs an existing old article without admitting a new old archive item`, async () => {
  const known = { ...items(`repair-${kind}`, 1)[0]!, date: null };
  const { id, listing } = await source(`repair-${kind}`, kind, [known]);
  assert.equal((await collectSource(id)).created, 1);
  const oldDate = new Date(Date.now() - 14 * 86400000).toISOString();
  listing.items = [{ ...known, title: "Corrected known article", date: oldDate },
    { ...known, url: `${known.url}-unseen`, title: "Unseen old article", date: oldDate }];
  listing.version += 1;
  const repaired = await collectSource(id);
  assert.deepEqual([repaired.status, repaired.created, repaired.revised], ["ok", 0, 1]);
  const [saved] = await sql`SELECT title,published_at,backfill,backfill_reason FROM articles WHERE source_id=${id}`;
  assert.equal(saved!.title, "Corrected known article");
  assert.equal(new Date(saved!.published_at).toISOString().slice(0, 19), oldDate.slice(0, 19));
  assert.equal(saved!.backfill, true);
  assert.equal(saved!.backfill_reason, "stale-on-discovery");
  assert.equal(await count(id), 1);
});

test("a long listing still keeps to the detail budget and to the detail titles already known", async () => {
  const rows = items("detail", 100).map(i => ({ ...i, title: "Read more", date: null }));
  const { id } = await source("detail", "web_list", rows, { detail: { maxFetches: 3, titleSelector: "h1", titleAuthoritative: true, publishedAtSelector: "time" } });
  const before = detailRequests.length;
  const result = await collectSource(id);
  assert.equal(result.status, "ok");
  assert.equal(result.created, 100);
  assert.equal(detailRequests.length - before, 3);
  const saved = await sql`SELECT title FROM articles WHERE source_id=${id}`;
  assert.equal(saved.filter(a => a.title.startsWith("详细标题")).length, 3);
  const repeat = await collectSource(id);
  assert.deepEqual([repeat.status, repeat.created, repeat.revised], ["ok", 0, 3]);
  assert.equal(detailRequests.length - before, 6, "the next run enriches the next three incomplete articles");
  assert.equal(await revisions(id), 103);
});

test("in the tail an alias of a known URL keeps the first record, and URL, category and noise filters still apply", async () => {
  const rows = items("filters", 60);
  rows.push({ ...rows[0]!, url: rows[0]!.url + "?utm_source=tail", title: "不应覆盖首次标题" });
  rows.push(...items("filters-tail", 5));
  rows[62]!.title = "noise 排除条目";
  rows[63]!.url = `${base}/denied/${T}`;
  rows[64]!.category = "drop";
  rows[65]!.url = `${base}/outside/${T}`;
  const { id } = await source("filters", "rss", rows, {
    allowUrlPrefixes: [`${base}/article/`, `${base}/denied/`], denyUrlPrefixes: [`${base}/denied/`],
    allowCategories: ["keep"], denyCategories: ["drop"], ingestNoiseFilter: { dropMarkersTitleOnly: ["noise"] },
  });
  const first = await collectSource(id);
  assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", 66, 61, 0]);
  const [saved] = await sql`SELECT title,revision FROM articles WHERE url=${rows[0]!.url}`;
  assert.deepEqual([saved!.title, saved!.revision], [rows[0]!.title, 1]);
  assert.deepEqual(await collectSource(id, { force: true }), { sourceId: id, status: "ok", found: 66, created: 0, revised: 0 });
  assert.equal(await count(id), 61);
  assert.equal(await revisions(id), 61);
});

test("a storage failure in the tail does not advance the feed's validator; the retry fills in without new revisions", async () => {
  const rows = items("retry", 61);
  const { id, listing } = await source("retry", "rss", rows.slice(0, 1));
  assert.equal((await collectSource(id)).created, 1);
  const previous = await cursor(id);
  listing.items = rows;
  listing.version = 2;
  const constraint = `tail_failure_${T}`;
  // Refuse only this test's tail title: the entries before it commit, and the code needs no fault switch.
  // DDL takes no bound values, so the escaped title goes in as a literal.
  const blockedTitle = sql.unsafe("'" + rows[60]!.title.replaceAll("'", "''") + "'");
  await sql`ALTER TABLE articles ADD CONSTRAINT ${sql(constraint)} CHECK (title <> ${blockedTitle}) NOT VALID`;
  try {
    const failed = await collectSource(id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, new RegExp(constraint));
    assert.equal(await count(id), 60, "the entries before the 61st stay committed");
    assert.deepEqual(await cursor(id), previous);
    const [run] = await sql`SELECT status,found_count FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
    assert.deepEqual([run!.status, run!.found_count], ["failed", 61]);
  } finally {
    await sql`ALTER TABLE articles DROP CONSTRAINT ${sql(constraint)}`;
  }
  const retried = await collectSource(id);
  assert.deepEqual([retried.status, retried.created, retried.revised], ["ok", 1, 0]);
  assert.equal(listing.requests.at(-1)!.etag, '"v1"');
  assert.equal((await cursor(id)).rss.etag, '"v2"');
  assert.equal(await count(id), 61);
  assert.equal(await revisions(id), 61);
  assert.equal(await jobs(id), 61);
  assert.equal((await collectSource(id)).found, 0);
  assert.equal(listing.requests.at(-1)!.status, 304);
});
