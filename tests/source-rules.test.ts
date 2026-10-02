// Every rule a source's config names is applied, and a name the collector does not implement fails the
// fetch. Configs that carried adapters and detail rules a collector does not implement used to fall
// back silently (junk titles, RSS entries outside the source's URL rules, dates from the wrong place).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { extractArticleBody, readable } from "@aihot/backend/content/extract";
import { collectSource } from "@aihot/backend/sources/collect";
import { updateSource } from "@aihot/backend/admin/sources";

const T = tag();
const LONG = `${"A card label that swallowed the summary of the article it links to, ".repeat(2)}${T}`;
let jinaDetailReads = 0;
let jinaListingReads = 0;
const pageReads = new Map<string, number>();
const ARTICLE_BODY = "A complete article with enough material to preserve the same extraction result without downloading it twice. ".repeat(6);
const html = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`;
const pages: Record<string, (base: string) => string> = {
  "/feed.xml": () =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>` +
    ["news/a", "business/b"].map((p) => `<item><title>Entry ${p} ${T}</title><link>https://example.org/rules-${T}/${p}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join("") +
    `</channel></rss>`,
  "/list.html": () => html("", `<ul><li><a href="/p/a-${T}">Short clean title ${T}</a><time>2026-09-20</time></li><li><a href="/p/b-${T}">${LONG}</a></li></ul>`),
  [`/p/a-${T}`]: () =>
    html(`<meta name="description" content="Summary of A"><meta property="article:published_time" content="2026-01-01T00:00:00Z">`, `<h1>Detail heading A</h1><p class="byline"><time datetime="2026-09-21T08:00:00Z">Sep 21</time></p>`),
  [`/p/b-${T}`]: () => html(`<meta name="description" content="Summary of B"><meta property="article:published_time" content="2026-01-01T00:00:00Z">`, `<article><h1>Detail heading B ${T}</h1><p>${ARTICLE_BODY}</p></article>`),
  [`/j/1-${T}`]: () => html(`<meta property="article:published_time" content="2026-09-27T01:00:00Z">`, "<p>one</p>"),
  [`/j/2-${T}`]: () => html(`<meta property="article:published_time" content="2026-09-27T02:00:00Z">`, "<p>two</p>"),
  [`/image-${T}`]: () => html("", '<img src="/logo.png"><div class="notice"><img src="/prices.png" alt="挂牌价"><div class="share">分享</div></div><footer>联系我们</footer>'),
};
// Jina Reader: GET /<target URL> answers the rendering, with its header lines.
const jina = (base: string, target: string) => {
  const md = target.endsWith(`/jlist-${T}`)
    ? `[Short Jina title ${T}](${base}/j/1-${T})\n\n[${LONG}](${base}/j/2-${T})`
    : `# Heading from Jina ${T}\n\nThe article.`;
  if (target.endsWith(`/jlist-${T}`)) jinaListingReads += 1;
  else jinaDetailReads += 1;
  return `Title: Page\nURL Source: ${target}\nPublished Time: 2026-09-27T00:00:00Z\nMarkdown Content:\n${md}`;
};
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  pageReads.set(path, (pageReads.get(path) ?? 0) + 1);
  const body = path.startsWith("/http") && path.endsWith(`/rendered-${T}`)
    ? req.headers["x-return-format"] === "html" ? pages[`/image-${T}`]!(base) : "整页菜单".repeat(200)
    : path.startsWith("/http") && path.endsWith(`/markdown-${T}`) ? `Markdown Content:\n\n${ARTICLE_BODY}\n\n![价格表](${base}/prices.png)`
    : path.startsWith("/http") ? jina(base, path.slice(1)) : Object.hasOwn(pages, path) ? pages[path]!(base) : null;
  res.writeHead(body === null ? 404 : 200, { "content-type": path.endsWith(".xml") ? "application/rss+xml" : "text/html; charset=utf-8" });
  res.end(body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
process.env.JINA_BASE_URL = base;
process.env.JINA_API_KEY = "test-key";

const SOURCES = {
  unsupported: { kind: "rss", config: { feedUrl: `${base}/feed.xml`, adapter: "feed_cards" } },
  denied: { kind: "rss", config: { feedUrl: `${base}/feed.xml`, denyUrlPrefixes: [`https://example.org/rules-${T}/business/`] } },
  detail: {
    kind: "web_list",
    config: {
      url: `${base}/list.html`, parseMode: "html", itemSelector: "li", linkSelector: "a", titleSelector: "a", publishedAtSelector: "time",
      detail: { maxFetches: 10, titleSelector: "h1", summarySelector: 'meta[name="description"]', publishedAtAuthoritative: true, publishedAtSelector: ".byline time" },
    },
  },
  jina: { kind: "web_list", config: { url: `https://r.jina.ai/${base}/jlist-${T}`, parseMode: "markdown", allowUrlPrefixes: [`${base}/j/`], detail: { maxFetches: 5, titleRegex: "^# (.+)$" } } },
  image: { kind: "web_list", config: { body: { selector: ".notice", removeSelectors: [".share"] } } },
};
const id = (name: keyof typeof SOURCES) => `test-rules-${name}-${T}`;
let savedJina: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  savedJina = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'jina'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'jina'`;
  const cursor = sql.json({ initializedAt: new Date().toISOString() });
  for (const [name, s] of Object.entries(SOURCES)) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
              VALUES (${id(name as keyof typeof SOURCES)}, ${name}, ${s.kind}, ${sql.json(s.config)}, 'T1', 'editorial', ${cursor}, '2100-01-01')`;
  }
});
after(async () => {
  for (const b of savedJina) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = 'jina'`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const articles = (sourceId: string) =>
  sql<{ url: string; title: string; excerpt: string | null; published_at: Date | null; revision: number }[]>`
    SELECT url, title, excerpt, published_at, revision FROM articles WHERE source_id = ${sourceId} ORDER BY url`;

test("a config entry the collector does not implement fails the fetch instead of being ignored", async () => {
  const run = await collectSource(id("unsupported"), { force: true });
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /unsupported config: adapter/);
  assert.equal((await articles(id("unsupported"))).length, 0, "nothing collected by a fallback parse");
  const [row] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${id("denied")}`;
  await assert.rejects(
    updateSource(id("denied"), { patch: { config: { ...SOURCES.denied.config, detail: { titleFoo: "h1" } } }, version: row!.updated_at.toISOString() }, "test"),
    /不支持的配置项：detail\.titleFoo/,
    "the admin refuses it before it is saved",
  );
});

test("feed entries outside the source's URL rules are skipped", async () => {
  assert.equal((await collectSource(id("denied"), { force: true })).status, "ok");
  assert.deepEqual((await articles(id("denied"))).map((a) => a.url), [`https://example.org/rules-${T}/news/a`]);
});

test("detail rules fill what the listing lacks, and a detail title survives the next listing", async () => {
  for (let run = 0; run < 2; run++) assert.equal((await collectSource(id("detail"), { force: true })).status, "ok");
  const [a, b] = await articles(id("detail"));
  assert.deepEqual([a!.title, a!.excerpt, a!.published_at?.toISOString(), a!.revision], [`Short clean title ${T}`, "Summary of A", "2026-09-21T08:00:00.000Z", 1],
    "a clean listing title stays; the byline, not the listing date or page metadata, dates it");
  assert.deepEqual([b!.title, b!.excerpt, b!.published_at, b!.revision], [`Detail heading B ${T}`, "Summary of B", null, 1],
    "a label that swallowed its summary takes the page's heading; without a byline there is no date; the listing does not revise it back");
});

test("a Jina listing is read on every fetch, and buys a detail rendering only where a regex rule needs it", async () => {
  assert.equal((await collectSource(id("jina"), { force: true })).status, "ok");
  const rows = await articles(id("jina"));
  assert.deepEqual(rows.map((r) => [r.title, r.published_at?.toISOString()]), [
    [`Short Jina title ${T}`, "2026-09-27T01:00:00.000Z"],
    [`Heading from Jina ${T}`, "2026-09-27T02:00:00.000Z"],
  ], "the title regex reads Jina's text; dates come from the pages' own HTML");
  assert.equal(jinaDetailReads, 1, "one paid detail rendering: only the long title needed one");
  assert.equal((await collectSource(id("jina"), { force: true })).status, "ok");
  assert.deepEqual([jinaListingReads, jinaDetailReads], [2, 1], "every fetch reads the listing afresh; known articles buy no detail");
});


test("detail HTML supplies the ordinary extracted body once, while short pages keep extraction pending", async () => {
  const rows = await sql<{ id: string; url: string; body_html: string | null; body_text: string | null; body_status: string }[]>`
    SELECT id, url, body_html, body_text, body_status FROM articles WHERE source_id = ${id("detail")} ORDER BY url`;
  const [short, full] = rows;
  assert.equal(short!.body_status, "pending", "an unconfirmed body retains the original extraction fallback");
  const expected = readable(pages[`/p/b-${T}`]!(base), `${base}/p/b-${T}`)!;
  assert.deepEqual([full!.body_html, full!.body_text, full!.body_status], [expected.html, expected.text, "ok"]);
  assert.equal(await extractArticleBody(full!.id, false), "skipped");
  assert.equal(pageReads.get(`/p/b-${T}`), 1, "known listings and extraction never download the same confirmed body again");
});

test("worker re-extraction applies source body rules and replaces stale logo media", async () => {
  const { upsertMaterial } = await import("@aihot/backend/content/materials");
  const { articleId } = await upsertMaterial({ sourceId: id("image"), url: `${base}/image-${T}`, title: "挂牌公告", via: "fetch",
    bodyText: "旧菜单", bodyHtml: "<p>旧菜单</p>", bodyStatus: "pending", media: [{ kind: "image", url: `${base}/logo.png` }] });
  assert.equal(await extractArticleBody(articleId, false), "ok");
  const [row] = await sql`SELECT body_html, body_text, body_status, media, revision FROM articles WHERE id = ${articleId}`;
  assert.deepEqual([row!.body_text, row!.body_status, row!.revision], ["", "ok", 2]);
  assert.doesNotMatch(row!.body_html, /logo|分享|联系|旧菜单/);
  assert.equal(row!.media[0].url, `${base}/prices.png`);
  const { fetchDetail } = await import("@aihot/backend/sources/web-list");
  const detail = await fetchDetail(`${base}/image-${T}`, { config: SOURCES.image.config } as never, { date: true, title: false, summary: false, body: true });
  assert.equal(detail.body!.html, row!.body_html, "metadata reuse follows the same rules as the worker");
});

test("Jina fallback enforces the same body container and retains Markdown images for vision", async () => {
  const { extractFromUrl } = await import("@aihot/backend/content/extract");
  const opts = { allowJina: true, subject: `test:${T}`, body: SOURCES.image.config.body };
  const body = await extractFromUrl(`${base}/rendered-${T}`, opts);
  assert.equal(body!.via, "jina");
  assert.deepEqual(body!.images.map((image) => image.url), [`${base}/prices.png`]);
  assert.doesNotMatch(body!.markdown, /logo|分享|联系|菜单/);
  assert.equal(await extractFromUrl(`${base}/rendered-${T}`, { ...opts, body: { selector: ".missing" } }), null);
  const generic = await extractFromUrl(`${base}/markdown-${T}`, { allowJina: true, subject: `test:${T}` });
  assert.equal(generic!.images[0]!.url, `${base}/prices.png`, "generic Markdown fallback also supplies image metadata");
});


test("detail collection persists the selected DOM and its confirmed selector for later image rules", async () => {
  const sourceId = `reading-detail-${T}`;
  pages[`/reading-list-${T}`] = () => html("", `<div class="news"><a href="/image-${T}">模型服务发布最新价格公告</a></div>`);
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${sourceId}, 'Detail reading fixture', 'web_list',
    ${sql.json({ url: `${base}/reading-list-${T}`, itemSelector: ".news", linkSelector: "a", titleSelector: "a",
      detail: { maxFetches: 2, publishedAtSelector: "time" }, body: { selector: ".notice", images: { keepSelectors: [".notice img"] } } })})`;
  // Use a distinct URL from the re-extraction fixture so this entrance owns the new material.
  pages[`/reading-image-${T}`] = pages[`/image-${T}`]!;
  pages[`/reading-list-${T}`] = () => html("", `<div class="news"><a href="/reading-image-${T}">模型服务发布最新价格公告</a></div>`);
  const collected = await collectSource(sourceId, { force: true });
  assert.equal(collected.status, "ok", collected.error ?? "collection failed");
  const [row] = await sql`SELECT body_snapshot_html, body_snapshot_selector, body_status FROM articles WHERE source_id = ${sourceId}`;
  assert.ok(row);
  assert.equal(row.body_status, "ok");
  assert.equal(row.body_snapshot_selector, ".notice");
  const { bodyBlocks } = await import("@aihot/backend/content/blocks");
  const blocks = bodyBlocks(row.body_snapshot_html, base, { images: { keepSelectors: [".notice img"] } });
  assert.equal(blocks.find((b) => b.kind === "image")?.rule, "keep");
});
