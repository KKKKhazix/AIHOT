// An X post's own text, its translation, the post it quotes and its media are its body, on a site that
// counts them as one (POLICY.xPostIsFullText): it shows them only when the source allows full text
// (site_fulltext), full RSS only when it may also syndicate. Every other exit keeps the item with its
// licensed summary.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { updateSource } from "@aihot/backend/admin/sources";
import { upsertMaterial, type XPostData } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary, type ItemRow } from "@aihot/backend/publication/items";
import { publishArticle, republishSource } from "@aihot/backend/publication/publish";
import { POLICY } from "@aihot/site";
import { buildApp } from "../apps/api/src/app.ts";

const T = `x-license-${tag()}`;
const app = await buildApp();
let n = 0;
// A site that shows every X post like its title and summary has no unlicensed post text to hide.
const hidesPosts = { skip: !POLICY.xPostIsFullText && "this site shows every X post's own text" };

after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

async function fixture(options: {
  full?: boolean; syndicate?: boolean; kind?: "x_search" | "rss"; summary?: boolean;
  shape?: "missing" | "quote-only"; bodyStatus?: "ok" | "unconfirmed" | "none";
  translation?: "missing" | "stale" | "same"; mode?: "editorial" | "hot_signal" | "isolated";
} = {}) {
  n += 1;
  const key = `${T}-${n}`;
  const source = key;
  const tweet = `${Date.now()}${n}0`;
  const quote = `${Date.now()}${n}1`;
  const main = `X-MAIN-${key}`;
  const zh = options.translation === "same" ? main : `X-ZH-${key}`;
  const quoted = `X-QUOTED-${key}`;
  const quotedZh = options.translation === "same" ? quoted : `X-QUOTED-ZH-${key}`;
  const media = `X-MEDIA-${key}`;
  const summary = options.summary === false || options.shape === "quote-only" ? null : `摘要-${key}`;
  const kind = options.kind ?? "x_search";
  const url = kind === "x_search" ? `https://x.com/license/status/${tweet}` : `https://example.org/${key}`;
  const xPost: XPostData | null = kind === "rss" || options.shape === "missing" ? null : {
    tweetId: tweet, authorName: "许可测试作者", handle: "license", avatarUrl: "https://example.org/avatar.png",
    text: options.shape === "quote-only" ? "" : main,
    quoted: { authorName: "引用作者", handle: "quoted", text: quoted, url: `https://x.com/quoted/status/${quote}` },
    media: [
      { kind: "image", url: `https://example.org/${media}.png`, alt: `${media}-图片描述`, width: 800, height: 600 },
      { kind: "video", url: `https://example.org/${media}.mp4`, poster: `https://example.org/${media}-poster.png`, alt: `${media}-视频描述` },
    ],
  };
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, icon_url, next_fetch_at)
    VALUES (${source}, '许可测试来源', ${kind}, 'T1', ${options.mode ?? "editorial"}, ${options.full ?? false}, ${options.syndicate ?? true}, 'https://example.org/source.png', '2100-01-01')`;
  const { articleId: id } = await upsertMaterial({ sourceId: source, url, title: `Original title ${key}`, language: "en",
    bodyText: options.bodyStatus === "none" ? null : main, bodyHtml: options.bodyStatus === "none" ? null : `<p>${main}</p>`,
    bodyStatus: options.bodyStatus ?? "ok", xPost, via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, tags, score, selected)
    VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`标题-${key}`}, ${summary}, '推荐理由', ${[T, key]}, 90, true)`;
  if (options.translation !== "missing") {
    await sql`INSERT INTO translations (article_id, revision, body_text, body_html, origin)
      VALUES (${id}, ${options.translation === "stale" ? 0 : 1}, ${zh}, ${`<p>${zh}</p>`}, 'source')`;
  }
  await sql`INSERT INTO quote_translations (tweet_id, text_hash, text_zh, origin) VALUES (${quote}, ${key}, ${quotedZh}, 'reused')`;
  const story = randomUUID();
  const [savedStory] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title) VALUES (${story}, '许可测试事件') RETURNING id`;
  const fact = `fact-${key}`;
  const [savedFact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${fact}, ${savedStory!.id}, '许可测试进展') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${savedFact!.id}, ${id}, 'report')`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  const [publication] = await sql`SELECT body_mode, eligible FROM publications WHERE article_id = ${id}`;
  assert.equal(publication!.body_mode, options.full && (!options.bodyStatus || options.bodyStatus === "ok") ? "full" : "summary");
  assert.equal(publication!.eligible, (!!summary || options.shape === "quote-only") && (!options.mode || options.mode === "editorial"));
  return { id, source, key, fact, story, url, summary, main, zh, quoted, quotedZh, media, markers: [main, zh, quoted, quotedZh, media] };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function get(url: string, status = 200, type = /application\/json/) {
  const response = await app.inject({ method: "GET", url });
  assert.equal(response.statusCode, status, `${url}: ${response.body}`);
  assert.match(String(response.headers["content-type"]), type, url);
  return response;
}

function noContent(body: string, f: Fixture) {
  for (const marker of f.markers) assert.ok(!body.includes(marker), `未授权内容泄露：${marker}`);
}

async function summaryDetail(f: Fixture) {
  for (const suffix of ["", "/original"]) {
    const response = await get(`/api/site/items/${f.id}${suffix}`);
    const detail = response.json();
    assert.equal(detail.id, f.id);
    assert.equal(detail.summary, f.summary);
    assert.equal(detail.links.original, f.url);
    noContent(response.body, f);
    assert.equal(detail.x, null);
    assert.equal(detail.body, null);
    assert.equal(detail.readingMode, "full", "全文许可不等于严格仅摘要的人工可见性");
    assert.equal(detail.markdownAvailable, !!f.summary);
  }
}

async function summaryMarkdown(f: Fixture) {
  const response = await get(`/items/${f.id}/markdown`, f.summary ? 200 : 404, f.summary ? /text\/markdown/ : /text\/plain/);
  noContent(response.body, f);
  if (f.summary) {
    assert.ok(response.body.includes(f.summary));
    assert.ok(response.body.includes(f.url));
  }
}

async function summaryLists(f: Fixture) {
  // The group's report list carries titles and sources only, no summaries.
  for (const [path, summary] of [[`/api/site/timeline?tag=${f.key}`, true], [`/api/site/pool?tag=${f.key}`, true], [`/api/site/groups/${f.fact}/reports`, false]] as const) {
    const response = await get(path);
    assert.ok(response.body.includes(f.id), `${path} 确实包含目标条目`);
    if (summary) assert.ok(response.body.includes(f.summary!), `${path} 保留摘要`);
    noContent(response.body, f);
  }
  // Topic pages and the other card lists share this projection.
  const [row] = await sql<ItemRow[]>`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id = ${f.id}`;
  assert.equal(toFeedItemSummary(row!).x, null);
}

async function feedItem(path: string, f: Fixture) {
  const response = await get(path, 200, /(?:application|text)\/(?:rss\+)?xml/);
  const item = response.body.match(/<item>[\s\S]*?<\/item>/g)?.find((part) => part.includes(`<guid isPermaLink="false">${f.id}</guid>`));
  assert.ok(item, `${path} 确实包含目标条目`);
  assert.ok(item.includes(f.summary!));
  return item;
}

async function revoke(f: Fixture, patch: { site_fulltext?: boolean; syndicate_fulltext?: boolean }) {
  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${f.source}`;
  await updateSource(f.source, { patch, version: source!.updated_at.toISOString(), reason: "本地许可测试" }, "test");
  const [queued] = await sql<{ value: { status: string } }[]>`SELECT value FROM settings WHERE key = ${`republish.source:${f.source}`}`;
  assert.equal(queued!.value.status, "queued");
  await republishSource(f.source);
  const [updated] = await sql`SELECT participation_mode FROM sources WHERE id = ${f.source}`;
  assert.equal(updated!.participation_mode, "editorial");
}

test("R01: X detail and original omit unlicensed text, translations, quotes and media", hidesPosts, async () => {
  await summaryDetail(await fixture());
});

test("R02: Markdown exports only the licensed summary", hidesPosts, async () => {
  await summaryMarkdown(await fixture());
});

test("R02: an unlicensed X post without a summary cannot enable Markdown", hidesPosts, async () => {
  const f = await fixture({ summary: false });
  await summaryDetail(f);
  await summaryMarkdown(f);
});

test("R03: every list projection retains the item without unlicensed X content", hidesPosts, async () => {
  await summaryLists(await fixture());
});

test("R04: revoking only site fulltext keeps editorial summaries after republishing", hidesPosts, async () => {
  const f = await fixture({ full: true });
  assert.ok((await get(`/api/site/items/${f.id}/original`)).body.includes(f.main));
  assert.ok((await feedItem("/feed/full.xml", f)).includes(f.zh));
  await revoke(f, { site_fulltext: false });
  await summaryDetail(f);
  await summaryMarkdown(f);
  await summaryLists(f);
  const feed = await feedItem("/feed/full.xml", f);
  noContent(feed, f);
  assert.ok(!feed.includes("content:encoded"));
});

test("R05: revoking only syndication preserves licensed site reading and Markdown", async () => {
  const f = await fixture({ full: true });
  await revoke(f, { syndicate_fulltext: false });
  assert.ok((await get(`/api/site/items/${f.id}`)).body.includes(f.zh));
  assert.ok((await get(`/api/site/items/${f.id}/original`)).body.includes(f.main));
  assert.ok((await get(`/items/${f.id}/markdown`, 200, /text\/markdown/)).body.includes(f.main));
  const feed = await feedItem("/feed/full.xml", f);
  noContent(feed, f);
  assert.ok(!feed.includes("content:encoded"));
});

for (const kind of ["x_search", "rss"] as const) {
  for (const full of [false, true]) for (const syndicate of [false, true]) {
    test(`R06/R07: ${kind} licence matrix site=${full}, syndicate=${syndicate}`, kind === "x_search" && !full ? hidesPosts : {}, async () => {
      const f = await fixture({ kind, full, syndicate });
      if (full) {
        const normal = (await get(`/api/site/items/${f.id}`)).json();
        const original = (await get(`/api/site/items/${f.id}/original`)).json();
        assert.equal(normal.bodyLanguage, "zh");
        assert.equal(normal.hasTranslation, true);
        assert.ok(normal.body.zh.includes(f.zh));
        assert.equal(normal.body.original, null);
        assert.ok(original.body.original.includes(f.main));
        assert.equal(original.body.zh, null);
        if (kind === "x_search") {
          assert.equal(normal.x.quoted.text, f.quoted);
          assert.equal(normal.x.quoted.translation, f.quotedZh);
          assert.equal(normal.x.media.length, 2);
          assert.ok(normal.x.media[0].url.includes(f.media));
          assert.ok(normal.x.media[0].srcSet.includes(f.media));
          assert.ok(normal.x.media[1].poster.includes(f.media));
          assert.equal(normal.x.media[1].kind, "video");
        }
        const md = (await get(`/items/${f.id}/markdown`, 200, /text\/markdown/)).body;
        for (const marker of kind === "x_search" ? [f.main, f.zh, f.quoted, f.quotedZh] : [f.main, f.zh]) assert.ok(md.includes(marker));
      } else {
        await summaryDetail(f);
        await summaryMarkdown(f);
      }
      const fullFeed = await feedItem("/feed/full.xml", f);
      assert.equal(fullFeed.includes("content:encoded"), full && syndicate);
      if (full && syndicate) assert.ok(fullFeed.includes(f.zh));
      else noContent(fullFeed, f);
      for (const path of ["/feed.xml", "/feed/all.xml"]) noContent(await feedItem(path, f), f);
      const v1 = await get(`/api/v1/items?mode=selected&q=${f.key}`);
      assert.ok(v1.body.includes(f.id));
      noContent(v1.body, f);
    });
  }
}

for (const shape of ["missing", "quote-only"] as const) {
  test(`R08: an unlicensed ${shape} X structure does not restore content`, hidesPosts, async () => {
    const f = await fixture({ shape });
    await summaryDetail(f);
    await summaryMarkdown(f);
  });
}
for (const bodyStatus of ["unconfirmed", "none"] as const) {
  test(`R08: site permission does not override body status ${bodyStatus}`, hidesPosts, async () => {
    const f = await fixture({ full: true, bodyStatus });
    await summaryDetail(f);
    await summaryMarkdown(f);
  });
}

for (const translation of ["missing", "stale", "same"] as const) {
  test(`R09: ${translation} translations retain existing licensed behavior and never bypass revocation`, hidesPosts, async () => {
    const f = await fixture({ full: true, translation });
    const detail = (await get(`/api/site/items/${f.id}`)).json();
    assert.equal(detail.hasTranslation, false);
    assert.equal(detail.body.zh, null);
    assert.ok(detail.body.original.includes(f.main));
    if (translation === "same") assert.equal(detail.x.quoted.translation, null);
    const md = (await get(`/items/${f.id}/markdown`, 200, /text\/markdown/)).body;
    if (translation === "missing" || translation === "stale") assert.ok(!md.includes(f.zh));
    await revoke(f, { site_fulltext: false });
    await summaryDetail(f);
    await summaryMarkdown(f);
  });
}

test("R10: summary-only and withdrawn visibility retain stricter detail and export rules", async () => {
  const f = await fixture({ full: true });
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${f.id}`;
  for (const suffix of ["", "/original"]) {
    const response = await get(`/api/site/items/${f.id}${suffix}`);
    const detail = response.json();
    assert.equal(detail.readingMode, "summary-only");
    assert.equal(detail.markdownAvailable, false);
    assert.equal(detail.body, null);
    assert.equal(detail.x, null);
    noContent(response.body, f);
  }
  await get(`/items/${f.id}/markdown`, 404, /text\/plain/);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${f.id}`;
  for (const path of [`/api/site/items/${f.id}`, `/api/site/items/${f.id}/original`, `/items/${f.id}/markdown`]) {
    await get(path, 404, path.endsWith("/markdown") ? /text\/plain/ : /application\/problem\+json/);
  }
});
for (const mode of ["hot_signal", "isolated"] as const) {
  test(`R10: ${mode} sources keep detail and Markdown unavailable`, async () => {
    const f = await fixture({ full: true, mode });
    for (const path of [`/api/site/items/${f.id}`, `/api/site/items/${f.id}/original`, `/items/${f.id}/markdown`]) {
      await get(path, 404, path.endsWith("/markdown") ? /text\/plain/ : /application\/problem\+json/);
    }
  });
}
