// Where search engines' fetches go, specified before the implementation:
// - topic archive pages (/topics/<slug>/page/N) are noindex, follow and reached from the topic page, so
//   neither the sitemap nor change notifications list them (2026-11-20);
// - nothing tells an engine what is new, so today's events, selections and reports queue behind old URLs;
// - pages whose own text is only a summary's worth are advertised to Google, which spends its fetches on them;
// - keeping those pages from Google also keeps them from the engines that index them, or from notifications;
// - the news section's dates leak into the notification inventory, so every URL looks changed;
// - an article whose event is covered by at least two distinct editorial sources competes at Google with that
//   event's page, while single-source clusters leave indexing to their own articles (2026-11-20).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { loadDiscoveryEntries } from "@aihot/backend/publication/sitemap";
import { ENGLISH } from "@aihot/contracts/english";
import { SITE } from "@aihot/site";
import { buildApp } from "../apps/api/src/app.ts";

const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

const HOUR = 3_600_000;
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * HOUR);
const key = tag();
const source = `focus-${key}`;
const sourceB = `focus-${key}-b`;
const id = (name: string) => `${source}-${name}`;

interface Report {
  at: Date;
  source?: string;
  channel?: "news" | "x";
  bodyMode?: "full" | "summary";
  body?: string;
  post?: string;
  article?: string;
  selected?: boolean;
  indexable?: boolean;
  manual?: boolean;
  tags?: string[];
  visibility?: "public" | "withdrawn";
}

async function report(name: string, r: Report) {
  const article = id(name);
  const src = r.source ?? source;
  const xPost = r.post === undefined ? null : { text: r.post, handle: "fixture", authorName: "Fixture" };
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,timeline_at,discovered_at,body_status,body_text,body_html,x_post,x_article)
    VALUES (${article},${src},${article},${`https://example.org/${article}`},'Fixture',${r.at},${r.at},${r.body === undefined ? "none" : "ok"},
      ${r.body ?? null},${r.body === undefined ? null : `<p>${r.body}</p>`},${xPost ? sql.json(xPost) : null},${r.article ? sql.json({ text: r.article }) : null})`;
  await sql`INSERT INTO publications (article_id,source_id,title,summary,url,timeline_at,discovered_at,sort_at,selected,eligible,indexable,
      visibility,visible_after,channel,category,body_mode,tags,seo_indexed_at)
    VALUES (${article},${src},'公开报道','一段转述原文的摘要。',${`https://example.org/${article}`},${r.at},${r.at},${r.at},${r.selected ?? true},true,
      ${r.indexable ?? true},${r.visibility ?? "public"},${r.at},${r.channel ?? "news"},'ai-models',${r.bodyMode ?? (r.body === undefined && !r.article ? "summary" : "full")},
      ${r.tags ?? []},${r.manual ? r.at : null})`;
  return article;
}

/** `own`: the members' page names this story as theirs, as publishing does for an article's primary event. */
async function story(members: string[], own = false) {
  const publicId = randomUUID();
  const [st] = await sql<{ id: number }[]>`INSERT INTO stories (public_id,title,latest_at) VALUES (${publicId},'事件',${ago(1)}) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,story_id,title) VALUES (${randomUUID()},${st!.id},'事实') RETURNING id`;
  for (const member of members) await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${member},'primary')`;
  if (own) await sql`UPDATE publications SET story_id = ${st!.id}, fact_id = ${fact!.id} WHERE article_id = ANY(${members})`;
  return publicId;
}

const long = "这是一篇完整的报道正文。".repeat(40);
const ids: Record<string, string> = {};
const stories: Record<string, string> = {};

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES
    (${source},'Focus','rss','T1','editorial'),
    (${sourceB},'Focus B','rss','T1','editorial')`;
  // A topic of three pages, all of it older than the news window.
  for (let n = 0; n < 45; n++) await report(`topic-${n}`, { at: ago(240 + n), body: long, tags: ["entity:minimax"] });
  Object.assign(ids, {
    long: await report("long", { at: ago(1), body: long }),
    noBody: await report("no-body", { at: ago(1) }),
    shortBody: await report("short-body", { at: ago(1), body: "只有一句话的快讯。" }),
    chinese300: await report("chinese-300", { at: ago(1), body: "字".repeat(300) }),
    post299: await report("post-299", { at: ago(1), channel: "x", bodyMode: "full", post: "a".repeat(299) }),
    post300: await report("post-300", { at: ago(1), channel: "x", bodyMode: "full", post: "a".repeat(300) }),
    postArticle: await report("post-article", { at: ago(1), channel: "x", bodyMode: "full", post: "A long read:", article: long }),
    manual: await report("manual", { at: ago(1), manual: true, selected: false }),
    hidden: await report("hidden", { at: ago(1), indexable: false, selected: false }),
    withdrawn: await report("withdrawn", { at: ago(1), body: long, visibility: "withdrawn" }),
    old: await report("old", { at: ago(72), body: long }),
    storyA: await report("story-a", { at: ago(2), body: long, selected: false, indexable: false }),
    storyB: await report("story-b", { at: ago(1), source: sourceB, body: long, selected: false, indexable: false }),
    lone: await report("lone", { at: ago(1), body: long, selected: false, indexable: false }),
    staleA: await report("stale-a", { at: ago(80), body: long, selected: false, indexable: false }),
    staleB: await report("stale-b", { at: ago(79), source: sourceB, body: long, selected: false, indexable: false }),
    pairA: await report("pair-a", { at: ago(1), body: long }),
    pairB: await report("pair-b", { at: ago(2), source: sourceB, body: long }),
    pairManual: await report("pair-manual", { at: ago(3), body: long, manual: true }),
    sameSourceA: await report("same-source-a", { at: ago(1), body: long }),
    sameSourceB: await report("same-source-b", { at: ago(2), body: long }),
    single: await report("single", { at: ago(1), body: long }),
  });
  Object.assign(stories, {
    fresh: await story([ids.storyA!, ids.storyB!]),
    lone: await story([ids.lone!]),
    stale: await story([ids.staleA!, ids.staleB!]),
    pair: await story([ids.pairA!, ids.pairB!, ids.pairManual!], true),
    sameSource: await story([ids.sameSourceA!, ids.sameSourceB!], true),
    single: await story([ids.single!], true),
  });
  // A daily that cites an article (including a withdrawn lead that must not leak into news.xml).
  await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,updated_at) VALUES
    ('daily','2099-01-02',${ago(25)},${ago(1)},${sql.json({
      leadItemId: ids.withdrawn,
      lead: { title: "已撤下的头条不应泄露" },
      highlights: [{ itemId: ids.long }],
      sections: [{ items: [{ itemId: ids.withdrawn, title: "已撤下的头条不应泄露" }, { itemId: ids.long, title: "公开报道" }] }],
    })},${ago(1)},${ago(1)}),
    ('daily','2099-01-01',${ago(97)},${ago(73)},'{}',${ago(73)},${ago(73)}),
    ('weekly','2099-W01',${ago(169)},${ago(1)},'{}',${ago(1)},${ago(1)})`;
});

const urls = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
const lastmod = (xml: string, path: string) => new RegExp(`<loc>[^<]*${path}</loc>\\n<lastmod>([^<]+)</lastmod>`).exec(xml)?.[1];
async function file(name: string) {
  const res = await app.inject(`/sitemaps/${name}.xml`);
  assert.equal(res.statusCode, 200, name);
  return res.body;
}

test("neither the sitemap nor notifications list a topic's archive pages", async () => {
  const topics = urls(await file("topics"));
  assert.ok(topics.includes("/topics/minimax"));
  assert.ok(!topics.some((path) => path.startsWith("/topics/minimax/page/")), "archive pages are reached from the topic page");
  const inventory = (await loadDiscoveryEntries(new Date())).map((e) => e.loc);
  assert.ok(inventory.includes("/topics/minimax"));
  assert.ok(!inventory.some((path) => path.startsWith("/topics/minimax/page/")), "archive pages are noindex: no engine is asked to fetch them");
});

test("a page whose own text is a summary's worth is kept from Google only, and from the sitemap", async () => {
  const listed = urls(await file("items"));
  const inventory = new Set((await loadDiscoveryEntries(new Date())).map((e) => e.loc));
  const expected: Record<string, { indexable: boolean; googleNoindex: boolean }> = {
    long: { indexable: true, googleNoindex: false },
    noBody: { indexable: true, googleNoindex: true },
    shortBody: { indexable: true, googleNoindex: true },
    chinese300: { indexable: true, googleNoindex: false },
    post299: { indexable: true, googleNoindex: true },
    post300: { indexable: true, googleNoindex: false },
    postArticle: { indexable: true, googleNoindex: false },
    manual: { indexable: true, googleNoindex: false },
    hidden: { indexable: false, googleNoindex: false },
  };
  for (const [name, want] of Object.entries(expected)) {
    const res = await app.inject(`/api/site/items/${ids[name]}`);
    assert.equal(res.statusCode, 200, name);
    const detail = res.json() as { indexable: boolean; googleNoindex: boolean };
    assert.deepEqual({ indexable: detail.indexable, googleNoindex: detail.googleNoindex }, want, name);
    assert.equal(listed.includes(`/items/${ids[name]}`), want.indexable && !want.googleNoindex, `${name}: the sitemap agrees with the page`);
    if (want.indexable) assert.ok(inventory.has(`/items/${ids[name]}`), `${name}: engines that index it are still notified`);
  }
});

test("an article whose event spans at least two sources is left to the event page at Google, while single-source clusters keep their own articles", async () => {
  const listed = urls(await file("items"));
  const inventory = new Set((await loadDiscoveryEntries(new Date())).map((e) => e.loc));
  // A full article otherwise indexed everywhere; an editor's mark keeps it; single-source clusters (1 or 2 reports) stay on their articles.
  const expected: Record<string, boolean> = { pairA: true, pairB: true, pairManual: false, sameSourceA: false, sameSourceB: false, single: false };
  for (const [name, googleNoindex] of Object.entries(expected)) {
    const res = await app.inject(`/api/site/items/${ids[name]}`);
    assert.equal(res.statusCode, 200, name);
    const detail = res.json() as { indexable: boolean; googleNoindex: boolean; story: { publicId: string; indexable?: boolean } | null };
    assert.ok(detail.story, `${name}: the page names its event`);
    assert.deepEqual({ indexable: detail.indexable, googleNoindex: detail.googleNoindex }, { indexable: true, googleNoindex }, name);
    assert.equal(listed.includes(`/items/${ids[name]}`), !googleNoindex, `${name}: the sitemap agrees with the page`);
    assert.ok(inventory.has(`/items/${ids[name]}`), `${name}: engines that index it are still notified`);
  }
  const events = urls(await file("stories"));
  assert.ok(events.includes(`/story/${stories.pair}`), "the multi-source event page stands for its reports");
  assert.ok(!events.includes(`/story/${stories.sameSource}`), "a single-source multi-report cluster is left to its reports' pages");
  assert.ok(!events.includes(`/story/${stories.single}`), "an event of one report is left to that report's page");
  assert.ok(inventory.has(`/story/${stories.pair}`));
  assert.ok(!inventory.has(`/story/${stories.sameSource}`), "its page is noindex: no engine is asked to fetch it");
  assert.ok(!inventory.has(`/story/${stories.single}`), "its page is noindex: no engine is asked to fetch it");
});

test("the news section lists the last 48 hours of events, selections and reports with Google News metadata", async () => {
  const index = (await app.inject("/sitemap.xml")).body;
  assert.ok(urls(index).includes("/sitemaps/news.xml"));
  const xml = await file("news");
  assert.match(xml, /xmlns:news="http:\/\/www\.google\.com\/schemas\/sitemap-news\/0\.9"/);
  const news = urls(xml);
  const newsBlock = (path: string) => new RegExp(`<url>\\n<loc>[^<]*${path}</loc>([\\s\\S]*?)</url>`).exec(xml)?.[1] ?? "";
  for (const path of [`/items/${ids.long}`, `/story/${stories.fresh}`, "/daily/2099-01-02", "/weekly/2099-W01"]) {
    assert.ok(news.includes(path), path);
    assert.ok(lastmod(xml, path), `${path} carries its date`);
    const block = newsBlock(path);
    assert.ok(block.includes(`<news:name>${SITE.name}</news:name>`), `${path} names the publication`);
    assert.match(block, /<news:language>[a-z]{2}(?:-[a-z]{2})?<\/news:language>/, `${path} declares ISO language`);
    assert.ok(block.includes(`<news:publication_date>${lastmod(xml, path)}</news:publication_date>`), `${path} publication_date matches`);
    assert.match(block, /<news:title>[^<]+<\/news:title>/, `${path} carries a non-empty news title`);
  }
  assert.ok(!newsBlock("/daily/2099-01-02").includes("已撤下的头条不应泄露"), "a withdrawn daily lead never leaks into news.xml");
  assert.ok(newsBlock("/daily/2099-01-02").includes("公开报道"), "daily news title advances to the next live citation");
  assert.equal(lastmod(xml, `/items/${ids.long}`), ago(1).toISOString(), "a selection is dated by its release");
  assert.equal(lastmod(index, "/sitemaps/news.xml"), lastmod(xml, `/items/${ids.long}`), "sitemap index carries the shard's latest lastmod");
  assert.ok(lastmod(index, "/sitemaps/stories.xml"), "dated shards carry lastmod in the sitemap index");
  assert.equal(lastmod(index, "/sitemaps/pages.xml"), undefined, "undated shards do not invent lastmod in the sitemap index");
  for (const path of [`/items/${ids.old}`, `/story/${stories.stale}`, "/daily/2099-01-01"]) assert.ok(!news.includes(path), `${path} is older than 48 hours`);
  assert.ok(!news.includes(`/items/${ids.noBody}`), "only what the other sections list: not a page kept from Google");
  assert.ok(!news.includes(`/story/${stories.lone}`), "only what the other sections list: not a one-report event");
  assert.ok(!news.includes(`/story/${stories.sameSource}`), "only what the other sections list: not a single-source cluster");
  assert.ok(!news.includes(`/items/${ids.manual}`), "a page an editor marked for indexing is not a selection");
});

test("the news section's dates stay out of the notification inventory", async () => {
  const inventory = await loadDiscoveryEntries(new Date());
  assert.equal(inventory.find((e) => e.loc === `/items/${ids.long}`)?.lastmod, undefined, "an article has no modification clock of its own");
  assert.equal(inventory.find((e) => e.loc === "/daily/2099-01-02")?.lastmod ?? null, null, "a report that cites articles stays undated");
  assert.ok(urls(await file("reports")).includes("/daily/2099-01-02"));
  assert.equal(lastmod(await file("reports"), "/daily/2099-01-02"), undefined, "nor does the reports section borrow the news date");
});

test("the news section is served even when nothing is new", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: now + 5 * 24 * HOUR });
  const index = (await app.inject("/sitemap.xml")).body;
  assert.ok(urls(index).includes("/sitemaps/news.xml"), "an address engines learned does not come and go");
  const xml = await file("news");
  assert.equal(urls(xml).length, 0);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9" xmlns:news="http:\/\/www\.google\.com\/schemas\/sitemap-news\/0\.9">/);
});

test("on a site with an English edition its pages are listed again at /en, an article once its title is in English", { skip: ENGLISH === null }, async () => {
  const untranslated = await report("not-yet-english", { at: ago(1), body: long });
  await sql`UPDATE publications SET title = '还没翻成英文的标题' WHERE article_id = ${untranslated}`;
  await sql`INSERT INTO english_copy (zh_hash, zh, kind, en) VALUES (encode(sha256(convert_to('公开报道', 'UTF8')), 'hex'), '公开报道', 'headline', 'A public report')
            ON CONFLICT (zh_hash) DO UPDATE SET en = EXCLUDED.en, failures = 0`;
  const inventory = new Set((await loadDiscoveryEntries(new Date())).map((e) => e.loc));
  for (const path of ["/en", "/en/all", "/en/hot", "/en/daily", "/en/daily/2099-01-02", "/en/weekly/2099-W01", "/en/topics", "/en/agent", "/en/about", `/en/items/${ids.long}`]) {
    assert.ok(inventory.has(path), `${path} is listed`);
  }
  for (const path of ["/en/terms", "/en/privacy", "/en/changelog", `/en/items/${untranslated}`, `/en/items/${ids.withdrawn}`]) {
    assert.ok(!inventory.has(path), `${path} is not: no English edition, its title still Chinese, or not public`);
  }
  // The sitemap (built earlier in this file and kept five minutes) has the English pages in sections of their own.
  const index = (await app.inject("/sitemap.xml")).body;
  for (const section of ["en-pages", "en-reports", "en-topics"]) assert.match(index, new RegExp(`/sitemaps/${section}\\.xml`), section);
  assert.ok(urls(await file("en-pages")).includes("/en/all"));
  assert.ok(!urls(await file("pages")).some((path) => path === "/en" || path.startsWith("/en/")), "the Chinese sections stay Chinese");
});
