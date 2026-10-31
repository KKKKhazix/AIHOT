// A source's publication window: preview and collection keep exactly the same entries, on the first
// and every later run, whether the date comes from the listing or from the article page. Undated
// listings are not discarded before enrichment; old, future and missing dates stay out of storage and
// preview, and excluded history never queues paid work. Previews also apply the source's URL,
// category and noise rules as collection does.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource, enrichDetails, loadSource } from "@aihot/backend/sources/collect";
import { previewSource, previewStoredSource } from "@aihot/backend/admin/sources";
import { upsertMaterial } from "@aihot/backend/content/materials";

const T = tag();
const now = Date.now();
const cutoff = new Date(now - 86400000);
cutoff.setMilliseconds(0);
const boundary = cutoff.toISOString();
/** Listings that date their own entries, by path: RSS, JSON or HTML by the path's first segment. */
type Item = { id: string; date: string | null; link?: string; category?: string };
const lists = new Map<string, Item[]>();
/** Article pages by key, dated only on the page itself. */
const dates: Record<string, string | null> = {
  fresh: new Date(now - 3600000).toISOString(),
  old: new Date(now - 2 * 86400000).toISOString(),
  future: new Date(now + 2 * 86400000).toISOString(),
  missing: null,
  ancient: new Date(now - 60 * 86400000).toISOString(),
  knownAncient: new Date(now - 60 * 86400000).toISOString(),
};
const listedEarlier = new Date(now - 3 * 3600000).toISOString();
let headlineSuffix = "";
let feedWithFresh = false;
const articleReads: string[] = [];
const server = http.createServer((req, res) => {
  const path = new URL(req.url!, base).pathname;
  const rows = lists.get(path);
  if (rows && path.startsWith("/json")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(rows));
    return;
  }
  if (rows && path.startsWith("/rss")) {
    res.setHeader("content-type", "application/rss+xml");
    res.end(`<rss version="2.0"><channel><title>Publication window</title>${rows.map(row =>
      `<item><title>${row.id}</title><link>${row.link ?? `${base}/article${path}/${row.id}`}</link>${row.category ? `<category>${row.category}</category>` : ""}${row.date ? `<pubDate>${new Date(row.date).toUTCString()}</pubDate>` : ""}</item>`).join("")}</channel></rss>`);
    return;
  }
  if (rows) {
    res.setHeader("content-type", "text/html");
    res.end(rows.map(row => `<article><a href="${base}/article${path}/${row.id}">${row.id}</a>${row.date ? `<time datetime="${row.date}"></time>` : ""}</article>`).join(""));
    return;
  }
  if (path.startsWith("/feed/")) {
    const etag = feedWithFresh ? '"v2"' : '"v1"';
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag }); res.end(); return; }
    const mode = path.split("/")[2];
    const keys = Object.keys(dates).filter(key => feedWithFresh || key !== "fresh");
    res.writeHead(200, { "content-type": "application/rss+xml", etag });
    res.end(`<rss version="2.0"><channel><title>Feed</title>${keys.map(key => `<item><title>An article ${key}</title><link>${base}/${mode}/${key}</link></item>`).join("")}</channel></rss>`);
    return;
  }
  res.setHeader("content-type", "text/html");
  if (path.startsWith("/preview-list/")) {
    // One article twice (a tracking alias), dated two hours before its page says, then a page that fails.
    const mode = path.split("/")[2];
    res.end(`<ul>${[`/${mode}/fresh`, `/${mode}/fresh?utm_source=list`, `/${mode}/broken`].map(href =>
      `<li><a href="${href}">Read more</a><time datetime="${listedEarlier}"></time></li>`).join("")}</ul>`);
  } else if (path.endsWith("/broken")) {
    res.writeHead(500);
    res.end("unavailable");
  } else if (path.startsWith("/list/")) {
    const mode = path.split("/")[2];
    const keys = new URL(req.url!, base).searchParams.get("keys")?.split(",") ?? Object.keys(dates);
    res.end(`<ul>${keys.map(key => `<li><a href="/${mode}/${key}">An article ${key}${headlineSuffix}</a>${mode?.startsWith("authoritative") ? `<time datetime="${dates.fresh}"></time>` : ""}</li>`).join("")}</ul>`);
  } else {
    articleReads.push(path);
    const date = dates[path.split("/")[2]!];
    // Pages of a "metadata" mode also name an older publication time in their generic metadata.
    const generic = path.split("/")[1]!.startsWith("metadata") ? `<meta property="article:published_time" content="${dates.old}">` : "";
    res.end(`<html><head>${date ? `<meta name="original-publication" content="${date}">` : ""}${generic}<meta property="article:modified_time" content="${dates.fresh}"></head><body><article><h1>Original article ${path.split("/")[2]}</h1><p>${"A complete original article. ".repeat(20)}</p></article></body></html>`);
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

for (const kind of ["rss", "web_list", "json_list"] as const) test(`${kind} applies the fixed publication window in preview, on the first and all subsequent runs`, async () => {
  const id = `window-${T}-${kind}`;
  const path = `/${kind}/${id}`;
  const rows: Item[] = [
    { id: "old", date: new Date(cutoff.getTime() - 86400_000).toISOString() },
    { id: "boundary", date: boundary },
    { id: "undated", date: null },
    { id: "future", date: new Date(Date.now() + 86400_000).toISOString() },
    { id: "current", date: new Date(Date.now() - 60_000).toISOString() },
  ];
  lists.set(path, rows);
  const mapping = kind === "rss" ? { feedUrl: base + path } : kind === "json_list"
    ? { url: base + path, titlePaths: ["id"], urlTemplate: `${base}/article${path}/{id}`, publishedAtPath: "date" }
    : { url: base + path, itemSelector: "article", linkSelector: "a", publishedAtSelector: "time" };
  const sourceConfig = { ...mapping, publishedAfter: boundary };
  await sql`INSERT INTO sources(id,name,kind,participation_mode,config,next_fetch_at)
    VALUES(${id},${id},${kind},'editorial',${sql.json(sourceConfig)},'2100-01-01')`;
  for (const preview of [await previewSource({ id, kind, config: sourceConfig }), await previewStoredSource(id)]) {
    assert.equal(preview!.count, 1, "preview applies the same publication boundary before reporting its count");
    assert.deepEqual(preview!.items.map(item => item.title), ["current"]);
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${id}`)[0]!.n, 0, "preview remains read-only");
  assert.equal((await collectSource(id)).created, 1);
  assert.equal((await collectSource(id)).created, 0, "a regular fetch must not start ingesting the old entries");
  rows.push({ id: "latest", date: new Date(Date.now() - 30_000).toISOString() });
  assert.equal((await collectSource(id)).created, 1);
  const saved = await sql`SELECT title FROM articles WHERE source_id=${id} ORDER BY title`;
  assert.deepEqual(saved.map(row => row.title), ["current", "latest"]);
  const [queued] = await sql`SELECT count(*)::int AS n FROM pgboss.job j JOIN articles a ON a.id=j.data->>'articleId' WHERE a.source_id=${id}`;
  assert.equal(queued!.n, 2, "excluded history never queues extraction or paid analysis");
});

test("previews keep exactly what collection stores, under the source's URL, category and noise rules", async () => {
  const id = `rules-${T}`;
  const path = `/rss/${id}`;
  const at = new Date(Date.now() - 60_000).toISOString();
  const kept = `${base}/article${path}/kept/`;
  lists.set(path, [
    { id: "kept", date: at, link: `${kept}1`, category: "AI" },
    { id: "denied-prefix", date: at, link: `${kept}private/2` },
    { id: "outside-allowed", date: at, link: `${base}/elsewhere/3` },
    { id: "denied-category", date: at, link: `${kept}4`, category: "Sports" },
    { id: "sponsored", date: at, link: `${kept}5` },
  ]);
  const sourceConfig = {
    feedUrl: base + path,
    allowUrlPrefixes: [kept],
    denyUrlPrefixes: [`${kept}private/`],
    denyCategories: ["Sports"],
    ingestNoiseFilter: { dropMarkers: ["sponsored"] },
    itemUrlPrefixRewrite: { from: kept, to: "https://example.org/kept/" },
  };
  await sql`INSERT INTO sources(id,name,kind,participation_mode,config,next_fetch_at)
    VALUES(${id},${id},'rss','editorial',${sql.json(sourceConfig)},'2100-01-01')`;
  const expected = [{ title: "kept", url: "https://example.org/kept/1" }];
  for (const preview of [await previewSource({ id, kind: "rss", config: sourceConfig }), await previewStoredSource(id)]) {
    assert.equal(preview!.count, 1);
    assert.deepEqual(preview!.items.map(({ title, url }) => ({ title, url })), expected);
  }
  assert.equal((await collectSource(id)).created, 1);
  assert.deepEqual((await sql`SELECT title, url FROM articles WHERE source_id=${id}`).map(({ title, url }) => ({ title, url })), expected);
});

for (const mode of ["undated", "authoritative"]) {
  test(`${mode} listing applies its boundary after original article dates in both preview and storage`, async () => {
    headlineSuffix = "";
    const id = `test-publication-window-${mode}-${T}`;
    const sourceConfig = {
      url: `${base}/list/${mode}`, itemSelector: "li", titleSelector: "a", linkSelector: "a", publishedAtSelector: "time",
      publishedAfter: boundary,
      detail: { maxFetches: 10, publishedAtSelector: 'meta[name="original-publication"]', publishedAtAuthoritative: mode === "authoritative" },
    };
    const preview = await previewSource({ id, kind: "web_list", config: sourceConfig });
    assert.deepEqual(preview.items.map(item => [item.url, item.publishedAt]), [[`${base}/${mode}/fresh`, dates.fresh]]);
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
      VALUES (${id}, ${id}, 'web_list', ${sql.json(sourceConfig)}, 'T1', 'editorial', ${sql.json({ initializedAt: new Date(now).toISOString() })}, '2100-01-01')`;
    for (let i = 0; i < 2; i++) assert.equal((await collectSource(id, { force: true })).status, "ok");
    const rows = await sql<{ url: string; published_at: Date }[]>`SELECT url, published_at FROM articles WHERE source_id = ${id}`;
    assert.deepEqual(rows.map(row => [row.url, row.published_at.toISOString()]), [[`${base}/${mode}/fresh`, dates.fresh]]);
    headlineSuffix = " revised";
    await sql`UPDATE sources SET config = ${sql.json({ ...sourceConfig, detail: { ...sourceConfig.detail, summarySelector: 'meta[name="description"]' } })} WHERE id = ${id}`;
    assert.equal((await collectSource(id, { force: true })).revised, 1, "a rule update must preserve a known date while admitting a genuine title revision");
    headlineSuffix = "";
  });
}

// An authoritative detail rule clears the feed date before admission; a newly dated archive must
// still be rejected after enrichment, while already stored undated material can recover its date.
test("source admission rechecks detail publication dates without discarding known material", async () => {
  const id = `test-detail-admission-${T}`;
  const mode = `authoritative-admission-${T}`;
  const sourceConfig = {
    url: `${base}/list/${mode}`, itemSelector: "li", titleSelector: "a", linkSelector: "a", publishedAtSelector: "time",
    detail: { maxFetches: 10, publishedAtSelector: 'meta[name="original-publication"]', publishedAtAuthoritative: true },
  };
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
    VALUES (${id}, ${id}, 'web_list', ${sql.json(sourceConfig)}, 'T1', 'editorial', ${sql.json({ initializedAt: new Date(now).toISOString() })}, '2100-01-01')`;
  const known = await upsertMaterial({ sourceId: id, url: `${base}/${mode}/knownAncient`, title: "Known undated material", publishedAt: null, via: "fetch" });
  assert.equal((await collectSource(id, { force: true })).status, "ok");
  const rows = await sql<{ id: string; url: string; published_at: Date | null }[]>`SELECT id, url, published_at FROM articles WHERE source_id = ${id}`;
  assert.ok(!rows.some(row => row.url.endsWith("/ancient")), "an old archive dated by the detail page must not be newly imported");
  assert.equal(rows.find(row => row.id === known.articleId)!.published_at?.toISOString(), dates.knownAncient);
  assert.ok(rows.some(row => row.url.endsWith("/fresh")), "genuine new material remains admitted");
  assert.equal(rows.find(row => row.url.endsWith("/missing"))!.published_at, null, "a missing original date stays unknown");
});

// The initial history month limit must also be applied to dates learned from article pages.
test("initial import does not admit archives outside its month limit after detail enrichment", async () => {
  const id = `test-first-detail-admission-${T}`;
  const mode = `authoritative-first-${T}`;
  const sourceConfig = {
    url: `${base}/list/${mode}`, itemSelector: "li", titleSelector: "a", linkSelector: "a", publishedAtSelector: "time",
    _aihot: { initialBackfillLimit: 30, initialBackfillMonths: 1 },
    detail: { maxFetches: 10, publishedAtSelector: 'meta[name="original-publication"]', publishedAtAuthoritative: true },
  };
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
    VALUES (${id}, ${id}, 'web_list', ${sql.json(sourceConfig)}, 'T1', 'editorial', '2100-01-01')`;
  assert.equal((await collectSource(id, { force: true })).status, "ok");
  const rows = await sql<{ url: string; backfill: boolean }[]>`SELECT url, backfill FROM articles WHERE source_id = ${id}`;
  assert.ok(!rows.some(row => /\/(ancient|knownAncient)$/.test(row.url)), "dates older than the initial month window stay outside import");
  assert.ok(rows.some(row => row.url.endsWith("/fresh")));
  assert.ok(rows.every(row => row.backfill), "the permitted initial import retains its history marker");
});

// An entry its article page dates out of admission is not stored, so every later listing offers it as new
// again. Reading it again each run pays for the same page and lets the same archive use up a small detail
// budget, so the entries after it are never read.
test("an entry the detail page dated out of admission is read once, and the budget moves on", async () => {
  const id = `test-detail-dated-out-${T}`;
  const mode = `undated-out-${T}`;
  const sourceConfig = {
    url: `${base}/list/${mode}`, itemSelector: "li", titleSelector: "a", linkSelector: "a",
    publishedAfter: boundary,
    detail: { maxFetches: 2, publishedAtSelector: 'meta[name="original-publication"]' },
  };
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
    VALUES (${id}, ${id}, 'web_list', ${sql.json(sourceConfig)}, 'T1', 'editorial', ${sql.json({ initializedAt: new Date(now).toISOString() })}, '2100-01-01')`;
  const reads = () => articleReads.filter(path => path.startsWith(`/${mode}/`));
  for (let i = 0; i < 4; i++) assert.equal((await collectSource(id, { force: true })).status, "ok");
  assert.deepEqual(reads().toSorted(), Object.keys(dates).map(key => `/${mode}/${key}`).toSorted(), "every article page is read once");
  const rows = await sql<{ url: string }[]>`SELECT url FROM articles WHERE source_id = ${id}`;
  assert.deepEqual(rows.map(row => row.url), [`${base}/${mode}/fresh`]);
  // Changed detail rules may date the pages differently: they are read again, within the budget.
  await sql`UPDATE sources SET config = ${sql.json({ ...sourceConfig, detail: { ...sourceConfig.detail, summarySelector: 'meta[name="description"]' } })} WHERE id = ${id}`;
  assert.equal((await collectSource(id, { force: true })).status, "ok");
  assert.equal(reads().length, Object.keys(dates).length + 2);
});

test("an RSS listing keeps its dated-out entries across a 304 before their next date check", async () => {
  const id = `test-detail-dated-out-rss-${T}`;
  const mode = `rss-out-${T}`;
  // Future entries need another listing when due; older exclusions permit a 304 before their next check.
  const sourceConfig = { feedUrl: `${base}/feed/${mode}`, publishedAfter: boundary, denyUrlPrefixes: [`${base}/${mode}/future`], detail: { maxFetches: 10, publishedAtSelector: 'meta[name="original-publication"]' } };
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
    VALUES (${id}, ${id}, 'rss', ${sql.json(sourceConfig)}, 'T1', 'editorial', ${sql.json({ initializedAt: new Date(now).toISOString() })}, '2100-01-01')`;
  const reads = () => articleReads.filter(path => path.startsWith(`/${mode}/`));
  feedWithFresh = false;
  assert.equal((await collectSource(id)).created, 0);
  assert.equal(reads().length, Object.keys(dates).length - 2);
  assert.equal((await collectSource(id)).found, 0, "the unchanged feed answers 304");
  feedWithFresh = true;
  assert.equal((await collectSource(id)).created, 1);
  assert.deepEqual(reads().slice(Object.keys(dates).length - 2), [`/${mode}/fresh`], "only the new entry is read");
});

// An undated listing cannot reveal a corrected date on the original page. A past exclusion must
// expire, including when an RSS validator would otherwise keep answering 304 forever.
for (const kind of ["web_list", "rss"] as const) test(`${kind} rechecks an excluded original date after a day`, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const id = `test-date-recheck-${kind}-${T}`;
  const mode = `date-recheck-${kind}-${T}`;
  const key = `corrected-${kind}`;
  dates[key] = dates.ancient!;
  const sourceConfig = {
    ...(kind === "rss" ? { feedUrl: `${base}/feed/${mode}` } : {
      url: `${base}/list/${mode}?keys=${key}`, itemSelector: "li", titleSelector: "a", linkSelector: "a",
    }),
    allowUrlPrefixes: [`${base}/${mode}/${key}`], publishedAfter: boundary,
    detail: { maxFetches: 1, publishedAtSelector: 'meta[name="original-publication"]' },
  };
  await sql`INSERT INTO sources (id,name,kind,config,tier,cursor,next_fetch_at)
    VALUES (${id},${id},${kind},${sql.json(sourceConfig)},'T1',${sql.json({ initializedAt: new Date(now).toISOString() })},'2100-01-01')`;
  const reads = () => articleReads.filter(path => path === `/${mode}/${key}`).length;
  try {
    assert.equal((await collectSource(id)).created, 0);
    dates[key] = dates.fresh!;
    t.mock.timers.tick(12 * 3600_000);
    assert.equal((await collectSource(id)).created, 0);
    assert.equal(reads(), 1, "an unchanged listing reuses the recent date check");
    t.mock.timers.tick(12 * 3600_000);
    assert.equal((await collectSource(id)).created, 1, "the corrected original date becomes admissible");
    assert.equal(reads(), 2);
    const [row] = await sql`SELECT published_at FROM articles WHERE source_id=${id}`;
    assert.equal(row!.published_at.toISOString(), dates.fresh);
  } finally { delete dates[key]; }
});

test("an expired original date stays excluded while its detail read waits for the existing budget", async () => {
  const id = `test-date-recheck-budget-${T}`;
  const sourceConfig = { url: `${base}/list/recheck-budget`, itemSelector: "li", linkSelector: "a",
    detail: { maxFetches: 1, publishedAtSelector: 'meta[name="original-publication"]' } };
  await sql`INSERT INTO sources (id,name,kind,config,tier) VALUES (${id},${id},'web_list',${sql.json(sourceConfig)},'T1')`;
  const source = (await loadSource(id))!;
  const candidates = ["fresh", "old"].map(key => ({ title: key, url: `${base}/recheck-budget/${key}`,
    identityKey: `url:${base}/recheck-budget/${key}`, publishedAt: null }));
  const admits = (c: { publishedAt?: Date | null }) => !c.publishedAt || c.publishedAt >= cutoff;
  const read = await enrichDetails(candidates, source, new Map(), { budget: 1, retries: {}, admits,
    datedOut: Object.fromEntries(candidates.map(c => [c.identityKey, [null, dates.ancient!, now - 2 * 86400_000]])) });
  assert.equal(read.pending, 1);
  assert.deepEqual(candidates.filter(admits).map(c => c.title), ["fresh"], "waiting to recheck must not turn an excluded archive into undated new material");
});

test("a date recheck without a replacement date keeps the known archive excluded", async () => {
  const id = `test-date-recheck-missing-${T}`;
  const sourceConfig = { url: `${base}/list/recheck-missing`, itemSelector: "li", linkSelector: "a",
    detail: { maxFetches: 1, publishedAtSelector: 'meta[name="original-publication"]' } };
  await sql`INSERT INTO sources (id,name,kind,config,tier) VALUES (${id},${id},'web_list',${sql.json(sourceConfig)},'T1')`;
  const source = (await loadSource(id))!;
  const candidate = { title: "missing", url: `${base}/recheck-missing/missing`, identityKey: `url:${base}/recheck-missing/missing`, publishedAt: null };
  const read = await enrichDetails([candidate], source, new Map(), { budget: 1, retries: {},
    admits: c => !c.publishedAt || c.publishedAt >= cutoff,
    datedOut: { [candidate.identityKey]: [null, dates.ancient!, now - 2 * 86400_000] } });
  assert.equal(read.attempts, 1);
  assert.equal(read.listed.get(candidate.identityKey)![1], dates.ancient, "a successful page without a date is not evidence to admit an excluded archive");
});

// Material another source collected takes nothing from this listing (only its own source revises it), so its
// article page is never worth a detail read. Reading it on every run also kept the budget from this source's own entries.
test("a listed entry another source owns is not read for details", async () => {
  const id = `test-detail-foreign-${T}`;
  const owner = `test-detail-foreign-owner-${T}`;
  const mode = `foreign-${T}`;
  const sourceConfig = {
    url: `${base}/list/${mode}?keys=fresh,missing`, itemSelector: "li", titleSelector: "a", linkSelector: "a",
    detail: { maxFetches: 1, publishedAtSelector: 'meta[name="original-publication"]', publishedAtAuthoritative: true },
  };
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${owner}, ${owner}, 'rss', 'T1')`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
    VALUES (${id}, ${id}, 'web_list', ${sql.json(sourceConfig)}, 'T1', 'editorial', ${sql.json({ initializedAt: new Date(now).toISOString() })}, '2100-01-01')`;
  await upsertMaterial({ sourceId: owner, url: `${base}/${mode}/fresh`, title: "Collected by another source", publishedAt: null, via: "fetch" });
  for (let i = 0; i < 2; i++) assert.equal((await collectSource(id, { force: true })).status, "ok");
  assert.deepEqual(articleReads.filter(path => path.startsWith(`/${mode}/`)), [`/${mode}/missing`], "only the source's own entry is read, once");
});

// A preview reads detail pages as collection does, with or without a publication boundary: an alias of
// one article is one entry and one read, a listing date gives way to the page's time on the same day, a
// detail title replaces a call to action, and a page that fails keeps its listing data. When no page can
// be read at all, the preview says so instead of quietly showing listing data only.
test("a preview reads detail pages under the same rules as collection", async () => {
  const id = `test-preview-${T}`;
  const mode = `preview-${T}`;
  const sourceConfig = {
    url: `${base}/preview-list/${mode}`, itemSelector: "li", titleSelector: "a", linkSelector: "a", publishedAtSelector: "time",
    detail: { maxFetches: 10, publishedAtSelector: 'meta[name="original-publication"]', upgradeDatePrecision: true, titleSelector: "h1" },
  };
  const preview = await previewSource({ id, kind: "web_list", config: sourceConfig });
  assert.deepEqual(articleReads.filter(path => path.startsWith(`/${mode}/`)), [`/${mode}/fresh`], "the alias is not read again");
  assert.deepEqual(preview.items.map(item => [item.title, item.publishedAt]), [["Original article fresh", dates.fresh], ["Read more", listedEarlier]]);
  await assert.rejects(previewSource({ id, kind: "web_list", config: { ...sourceConfig, allowUrlPrefixes: [`${base}/${mode}/broken`] } }), /broken/);
});

// The source's own date rule decides before the page's generic metadata: a body read from the same page
// must not put its metadata date first and keep the rule's date out because the two are days apart.
test("a detail date rule wins over the page's generic publication metadata", async () => {
  const id = `test-detail-rule-first-${T}`;
  const mode = `metadata-${T}`;
  const sourceConfig = {
    url: `${base}/list/${mode}?keys=fresh`, itemSelector: "li", titleSelector: "a", linkSelector: "a",
    detail: { maxFetches: 5, publishedAtSelector: 'meta[name="original-publication"]' },
  };
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
    VALUES (${id}, ${id}, 'web_list', ${sql.json(sourceConfig)}, 'T1', 'editorial', '2100-01-01')`;
  assert.equal((await collectSource(id, { force: true })).status, "ok");
  const [row] = await sql<{ published_at: Date; body_status: string }[]>`SELECT published_at, body_status FROM articles WHERE source_id = ${id}`;
  assert.equal(row!.body_status, "ok", "the body came from the same page");
  assert.equal(row!.published_at.toISOString(), dates.fresh);
});
