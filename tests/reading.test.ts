// What readers see of a group and a search: a folded card stands for the fact its representative
// reports (not an earlier fact with no selected report), and a query naming a company finds the
// articles about it that never write that name.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { textToHtml } from "@aihot/backend/content/sanitize";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const OFFICIAL = `test-reading-official-${T}`;
const MEDIA = `test-reading-media-${T}`;
const LEAKS = `test-reading-leaks-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${LEAKS}, 'Leaks', 'rss', 'T2', 'editorial', false, '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
async function report(source: string, opts: { selected: boolean; hoursAgo: number; subjects?: string[]; title?: string }) {
  n += 1;
  const at = new Date(Date.now() - opts.hoursAgo * 3600_000);
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.com/reading-${T}-${n}`, title: `Report ${n} ${T}`, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: at,
  });
  await sql`UPDATE articles SET discovered_at = ${at}, timeline_at = ${at} WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, subjects, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${opts.title ?? `标题${n}-${T}`}, ${`摘要${n}-${T}`}, 80, ${opts.selected}, ${opts.subjects ?? []}, ${[`t-${T}`]})`;
  return articleId;
}

test("a folded card's other sources are those of the fact its representative reports", async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`S-${T}`}, now(), now()) RETURNING id`;
  const [leak] = await sql<{ id: number; public_id: string }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`leak-${T}`}, ${story!.id}, '疑似泄露') RETURNING id, public_id`;
  const [launch] = await sql<{ id: number; public_id: string }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`launch-${T}`}, ${story!.id}, '正式发布') RETURNING id, public_id`;
  // The leak came first and was not selected; the launch has an official and a media report.
  const leaked = await report(LEAKS, { selected: false, hoursAgo: 20 });
  const official = await report(OFFICIAL, { selected: true, hoursAgo: 2 });
  const media = await report(MEDIA, { selected: true, hoursAgo: 1 });
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${leak!.id}, ${leaked}, 'report'), (${launch!.id}, ${official}, 'report'), (${launch!.id}, ${media}, 'report')`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id IN ${sql([leaked, official, media])}`;
  for (const id of [leaked, official, media]) await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });

  // This test's reports only.
  const res = await app.inject({ method: "GET", url: `/api/site/timeline?limit=40&tag=${encodeURIComponent(`t-${T}`)}` });
  const card = (JSON.parse(res.body).cards as Array<{ item: { id: string }; group: { factId: string; additionalSourceCount: number } | null }>)
    .find((c) => c.item.id === official || c.item.id === media);
  assert.ok(card, "the story has a card");
  assert.equal(card.item.id, official, "first-party representative");
  assert.equal(card.group?.factId, launch!.public_id, "the fact the representative reports");
  assert.equal(card.group?.additionalSourceCount, 1, "the launch's other source, not the leak's");
});

test("a query that names a company also finds the articles about it", async () => {
  const about = await report(MEDIA, { selected: false, hoursAgo: 3, subjects: ["anthropic"], title: `Sonnet 上线 Conductor ${T}` });
  const mention = await report(MEDIA, { selected: false, hoursAgo: 4, title: `claude 被一篇盘点顺带提到 ${T}` });
  const other = await report(MEDIA, { selected: false, hoursAgo: 5, title: `无关的新闻 ${T}` });
  for (const id of [about, mention, other]) await publishArticle(id);
  const search = async (q: string, tab = "") => {
    const res = await app.inject({ method: "GET", url: `/api/site/pool?q=${encodeURIComponent(q)}${tab}` });
    return (JSON.parse(res.body).items as Array<{ id: string }>).map((i) => i.id);
  };
  const latest = await search("Claude");
  assert.ok(latest.includes(about), "the Anthropic subject without the word");
  assert.ok(latest.includes(mention), "text matches stay");
  assert.ok(!latest.includes(other));
  const relevance = await search("claude", "&tab=relevance");
  assert.ok(relevance.indexOf(about) >= 0 && relevance.indexOf(about) < relevance.indexOf(mention), "the subject ranks first");
  // Only the whole query names the company: a narrower search stays a text search.
  assert.ok(!(await search(`claude ${T}-nothing`)).includes(about));
});

test("bare addresses in post text become safe links", () => {
  const html = textToHtml("see https://arxiv.org/abs/2502.11089. <b>x</b>\n\n1. one\n2. two");
  assert.match(html, /<a href="https:\/\/arxiv\.org\/abs\/2502\.11089" target="_blank" rel="noopener noreferrer nofollow">https:\/\/arxiv\.org\/abs\/2502\.11089<\/a>\./);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});
