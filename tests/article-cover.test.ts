// Failure cases: a body without pictures (the publisher's cover sits in the page header, outside what
// Readability reads) read as a wall of text on the page, in Markdown and in full RSS. The cover is kept apart
// from the body, so a feed sending the same body again leaves it alone, and it is decided where the page is in
// hand: body extraction, a listing's detail page, or one read of the page for a body that came with the feed.
// A page's share picture is not always the article's: the site's own card (Apple's research and newsroom
// pages, METR, Ollama, often with a version in its address; arXiv's logo on every paper, while its home page
// declares none), or the picture of a whole changelog page shared by its entries. An image service's address
// (/_next/image?url=…) names its picture in the query: IBM Research's and Sierra's covers are not their home's.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody, extractFromUrl } from "@aihot/backend/content/extract";
import { articleCover } from "@aihot/backend/content/cover";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { collectSource } from "@aihot/backend/sources/collect";
import { exportMarkdown, loadItemDetail } from "@aihot/backend/publication/detail";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const now = new Date();
const prose = "The article explains how the new model was trained and evaluated, with measurements. ".repeat(6);
const article = (title: string, image: string, body = `<p>${prose}</p><p>${prose}</p>`) =>
  `<html><head><title>${title}</title><meta property="og:image" content="${image}"></head><body><article><h1>${title}</h1>${body}</article></body></html>`;
const pages: Record<string, string> = {
  "/": article("Home", "/brand/og.png?v=4"),
  "/news/story": article("Story", "/images/story.jpg"),
  "/news/logo": article("Logo", "/brand/og.png?v=3"),
  "/news/pictured": article("Pictured", "/images/pictured.jpg", `<p>${prose}</p><figure><img src="/images/chart.png" alt="Chart"></figure><p>${prose}</p>`),
  "/news/fed": article("Fed", "/images/fed.jpg"),
  "/news/detail": article("Detail", "/images/detail.jpg"),
  "/news/later": article("Later", "/images/later.jpg"),
  "/listing": `<html><body><ul><li><a href="/news/detail">Detail</a></li><li><a href="/news/later">Later</a></li></ul></body></html>`,
};
const server = http.createServer((req, res) => {
  const path = new URL(req.url!, "http://site").pathname;
  if (path === "/feed") {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    return res.end(`<rss version="2.0"><channel><title>Feed</title><item><title>Fed</title><link>${base}/news/fed</link><pubDate>${now.toUTCString()}</pubDate><content:encoded><![CDATA[<p>${prose}</p><p>${prose}</p>]]></content:encoded></item></channel></rss>`);
  }
  const html = pages[path];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
  res.end(html ?? "<html><head><title>Not found</title></head><body>Not found</body></html>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
/** A site serving `shares` (path → declared share picture) as pages; other paths are not there. */
async function site(shares: Record<string, string | null>) {
  const s = http.createServer((req, res) => {
    const path = new URL(req.url!, "http://site").pathname;
    if (!(path in shares)) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<html><head><title>Not found</title></head><body>Not found</body></html>"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(shares[path] ? article(path, shares[path]!) : `<html><head><title>${path}</title></head><body><p>${prose}</p></body></html>`);
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => s.close(() => resolve())) };
}
const news = await site({
  "/": "/brand/og.png?v=3",
  "/newsroom": "/newsroom/images/default/logo-og.jpg?202611061854",
  "/research": "/_next/image?url=https%3A%2F%2Fcdn.example%2Fbase.jpg&w=1200",
});
const papers = await site({ "/": null, "/abs/2610.2": "/static/browse/0.3.4/images/logo-fb.png" });
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await news.close(); await papers.close(); await stopBoss(); await closeDb(); });
const coverOf = async (id: string) => ((await sql`SELECT cover FROM articles WHERE id = ${id}`)[0]!.cover as { url: string } | null)?.url ?? null;

test("the site's own share picture, a section's or another article's, and a changelog entry's page picture are no cover", async () => {
  const cover = (site: string, path: string) => ({ url: `${site}${path}`, width: null, height: null, alt: null });
  const at = (site: string, path: string, picture: string) => articleCover(cover(site, picture), `${site}${path}`, `${site}${path}`);
  assert.equal(await at(news.url, "/blog/post", "/brand/og.png?v=2"), null, "the home page's picture, another version");
  assert.equal(await at(news.url, "/newsroom/2026/11/results/", "/newsroom/images/default/logo-og.jpg?202611031825"), null, "the section's picture");
  const own = "/newsroom/images/2026/11/health/tile.jpg";
  assert.deepEqual(await at(news.url, "/newsroom/2026/11/health/", own), cover(news.url, own));
  assert.deepEqual(await at(news.url, "/blog/post", own), cover(news.url, own), "a section page that is not there declares nothing");
  const service = "/_next/image?url=https%3A%2F%2Fcdn.example%2Fstory.jpg&w=1200";
  assert.deepEqual(await at(news.url, "/research/story", service), cover(news.url, service), "an image service's query names the picture");
  assert.equal(await articleCover(cover(news.url, own), `${news.url}/docs/changelog#11-02-2026`, `${news.url}/docs/changelog`), null, "an entry of a page shares the page's picture");
  assert.equal(await articleCover(null, `${news.url}/blog/post`, `${news.url}/blog/post`), null);

  const sourceId = `cover-papers-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${sourceId}, 'Cover papers', 'rss', 'T1', 'editorial', '2100-01-01')`;
  await upsertMaterial({ sourceId, url: `${papers.url}/abs/2610.2`, title: "Another paper", bodyStatus: "pending", via: "fetch" });
  assert.equal(await at(papers.url, "/abs/2610.1", "/static/browse/0.3.4/images/logo-fb.png"), null, "the picture another article of the site declares too");
  assert.deepEqual(await at(papers.url, "/abs/2610.3", "/images/figure-1.png"), cover(papers.url, "/images/figure-1.png"));
});

test("body extraction keeps the page's cover apart from the body, and not the site's own picture", async () => {
  const sourceId = `cover-extract-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${sourceId}, 'Cover extraction', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const extracted = async (path: string) => {
    const { articleId } = await upsertMaterial({ sourceId, url: `${base}${path}`, title: path, bodyStatus: "pending", via: "fetch" });
    assert.equal(await extractArticleBody(articleId), "ok");
    return articleId;
  };
  const story = await extracted("/news/story");
  assert.equal(await coverOf(story), `${base}/images/story.jpg`);
  const [stored] = await sql`SELECT body_html, media FROM articles WHERE id = ${story}`;
  assert.doesNotMatch(stored!.body_html, /story\.jpg/);
  assert.deepEqual(stored!.media, []);
  assert.equal(await coverOf(await extracted("/news/logo")), null, "the home page's picture in another version");
  assert.equal(await coverOf(await extracted("/news/pictured")), null, "a body with a picture of its own");
});

test("a body that came with the feed takes its page's cover once, and a listing's detail page gives its own", async () => {
  const feedSource = `cover-feed-${T}`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor) VALUES (${feedSource}, 'Cover feed', 'rss',
    ${sql.json({ feedUrl: `${base}/feed` })}, 'T1', 'editorial', ${sql.json({ initializedAt: now.toISOString() })})`;
  assert.equal((await collectSource(feedSource)).status, "ok");
  const [fed] = await sql`SELECT id, body_html FROM articles WHERE source_id = ${feedSource}`;
  assert.equal(await coverOf(fed!.id), `${base}/images/fed.jpg`);
  pages["/news/fed"] = article("Fed", "/images/fed-changed.jpg");
  assert.equal((await collectSource(feedSource)).status, "ok");
  const [again] = await sql`SELECT body_html FROM articles WHERE id = ${fed!.id}`;
  assert.equal(await coverOf(fed!.id), `${base}/images/fed.jpg`, "decided once, when the article was first stored");
  assert.equal(again!.body_html, fed!.body_html, "the feed's body is stored as it came");

  const listSource = `cover-list-${T}`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor) VALUES (${listSource}, 'Cover listing', 'web_list',
    ${sql.json({ url: `${base}/listing`, itemSelector: "li", titleSelector: "a", detail: { maxFetches: 10 } })}, 'T1', 'editorial', ${sql.json({ initializedAt: now.toISOString() })})`;
  // Stored before its detail page was read (a run out of detail budget, or a failed read): its body and cover come later.
  const later = await upsertMaterial({ sourceId: listSource, url: `${base}/news/later`, title: "Later", bodyStatus: "pending", via: "fetch" });
  assert.equal((await collectSource(listSource)).status, "ok");
  const [detailed] = await sql`SELECT id, body_status FROM articles WHERE source_id = ${listSource} AND url = ${`${base}/news/detail`}`;
  assert.equal(detailed!.body_status, "ok");
  assert.equal(await coverOf(detailed!.id), `${base}/images/detail.jpg`);
  assert.equal((await sql`SELECT body_status FROM articles WHERE id = ${later.articleId}`)[0]!.body_status, "ok");
  assert.equal(await coverOf(later.articleId), `${base}/images/later.jpg`, "an article stored before its body takes the cover with it");
});

test("a run storing several articles of one site reads each page once and another of its articles once", async () => {
  const hits = new Map<string, number>();
  const items = ["/p/1", "/p/2", "/p/3"];
  const burst = http.createServer((req, res) => {
    const path = new URL(req.url!, "http://site").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/feed") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<rss version="2.0"><channel><title>Burst</title>${items.map((p) => `<item><title>Item ${p}</title><link>${burstUrl}${p}</link><pubDate>${now.toUTCString()}</pubDate><content:encoded><![CDATA[<p>${prose}</p><p>${prose}</p>]]></content:encoded></item>`).join("")}</channel></rss>`);
    }
    const item = items.includes(path);
    res.writeHead(item ? 200 : 404, { "content-type": "text/html" });
    res.end(item ? article(path, `/images${path}.jpg`) : "<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  await new Promise<void>((resolve) => burst.listen(0, "127.0.0.1", resolve));
  const burstUrl = `http://127.0.0.1:${(burst.address() as { port: number }).port}`;
  try {
    const sourceId = `cover-burst-${T}`;
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor) VALUES (${sourceId}, 'Cover burst', 'rss',
      ${sql.json({ feedUrl: `${burstUrl}/feed` })}, 'T1', 'editorial', ${sql.json({ initializedAt: now.toISOString() })})`;
    assert.equal((await collectSource(sourceId)).status, "ok");
    const stored = await sql<{ url: string; cover: { url: string } | null }[]>`SELECT url, cover FROM articles WHERE source_id = ${sourceId} ORDER BY url`;
    assert.deepEqual(stored.map((r) => r.cover?.url), items.map((p) => `${burstUrl}/images${p}.jpg`));
    const reads = items.reduce((n, p) => n + (hits.get(p) ?? 0), 0);
    assert.ok(reads <= items.length + 1, `${reads} page reads for ${items.length} articles`);
  } finally {
    await new Promise<void>((resolve) => burst.close(() => resolve()));
  }
});

test("a failure of the store while checking a cover is not taken for a page that cannot be read", async () => {
  // PostgreSQL refuses a NUL in text: the store fails here as it does when its connection drops. Extraction must
  // fail and be retried, not fall back to the paid renderer nor give up the body it already read.
  const lone = await site({ "/nul/story": "/images/unstored.jpg" });
  try {
    await assert.rejects(extractFromUrl(`${lone.url}/nul/story?ref=\u0000`, "cover-store-failure", {}, { paidFallback: false }));
  } finally {
    await lone.close();
  }
});

test("the page, Markdown and full RSS show the cover above a body without pictures of its own", async () => {
  const sourceId = `cover-outlets-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${sourceId}, 'Cover outlets', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const cover = { url: "https://cdn.publisher.example/cover.jpg", width: 1200, height: 630, alt: "A lab bench" };
  const make = async (suffix: string, bodyHtml: string) => {
    const id = `cover-${T}-${suffix}`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at, body_html, body_text, body_status, language, cover)
      VALUES (${id}, ${sourceId}, ${id}, ${`https://publisher.example/${id}`}, ${`Story ${suffix}`}, ${now}, ${now}, ${now}, ${bodyHtml}, 'The model is available today.', 'ok', 'en', ${sql.json(cover)})`;
    await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, published_at, sort_at,
        eligible, selected, visible_after, visibility, tags, summary, body_mode, syndicate, updated_at)
      VALUES (${id}, ${`Story ${suffix}`}, ${sourceId}, 'news', ${`https://publisher.example/${id}`}, ${now}, ${now}, ${now}, ${now},
        true, true, ${new Date(+now - 1000)}, 'public', ${[T]}, 'fixture summary', 'full', true, ${now})`;
    return id;
  };
  const plain = await make("plain", "<p>The model is available today.</p>");
  const pictured = await make("pictured", '<p>The model is available today.</p><figure><img src="https://cdn.publisher.example/chart.png" alt="Chart"></figure>');
  const proxied = encodeURIComponent(cover.url);

  const page = await loadItemDetail(plain, "original", now);
  assert.equal(page.kind, "found");
  const html = page.kind === "found" ? page.item.body?.original ?? "" : "";
  assert.match(html, /^<figure>.*?<img src="\/api\/img-proxy\?u=https%3A%2F%2Fcdn\.publisher\.example%2Fcover\.jpg&amp;[^"]*"[^>]*alt="A lab bench"[^>]*><\/picture><\/figure><p>The model/, "the page shows the cover first");
  assert.match((await exportMarkdown(plain))!.body, /!\[A lab bench\]\(https:\/\/cdn\.publisher\.example\/cover\.jpg\)/);
  const feed = await itemFeed("selected-full", null, { now });
  const item = (id: string) => feed.split("<item>").find((x) => x.includes(`<guid isPermaLink="false">${id}</guid>`)) ?? "";
  assert.ok(item(plain).includes(proxied), "full RSS carries it");

  const other = await loadItemDetail(pictured, "original", now);
  assert.ok(other.kind === "found" && !(other.item.body?.original ?? "").includes(proxied), "a body with its own picture shows that instead");
  assert.doesNotMatch((await exportMarkdown(pictured))!.body, /cover\.jpg/);
  assert.ok(item(pictured) && !item(pictured).includes(proxied));
});
