// Topic pages: which articles a topic takes, its chronicle and counts.
// Written before the code, from the ways it can go wrong:
// - a company topic takes an article about another company that only mentions it (several subjects,
//   its name nowhere in the title), or drops one about it whose title names it in English, in another
//   case, next to Chinese text, or only by a product (it is the article's only subject);
// - a Latin name matches inside another word ("Metadata" is not Meta); a headline naming a company
//   that is not a subject of the article gets in;
// - a technical-direction topic stops taking its tags;
// - the chronicle keeps a month's latest events instead of its most important ones, lists one event
//   twice across months, files 00:30 Beijing time on the 1st under the previous month, links an event
//   with a public story page to the article, or counts a withdrawn report's source;
// - a company's chronicle (its milestones) shows a tutorial, somebody else's commentary or another
//   organisation's research (even from an official source), drops the company's model/product launches,
//   or keeps more than three models, two products and one piece of its own news a month;
// - withdrawn or not yet released articles appear in a list, a count or the chronicle;
// - an article or story page names a topic its reports do not belong to;
// - a topic without content has no page, or an unknown slug or a page past the end has one.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTopicPage, listTopicSummaries, topicsOfStory } from "@aihot/backend/publication/topics";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const OFFICIAL = `test-topics-official-${T}`;
const MEDIA = `test-topics-media-${T}`;
const OTHER = `test-topics-other-${T}`;
const ZHIPU_BLOG = `test-topics-zhipu-blog-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${OTHER}, 'Other media', 'rss', 'T2', 'editorial', false, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, owner_entity_id, next_fetch_at) VALUES
    (${ZHIPU_BLOG}, 'Zhipu blog', 'rss', 'T1', 'editorial', true, 'zhipu', '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
interface Report {
  source?: string;
  at: Date;
  title: string;
  originalTitle?: string;
  subjects?: string[];
  tags?: string[];
  score?: number;
  selected?: boolean;
  fact?: number;
  category?: string;
}

/** A published report; `fact` links it to a fact before publishing, as grouping would. */
async function report(r: Report): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: r.source ?? MEDIA, url: `https://example.com/topics-${T}-${n}`, title: r.originalTitle ?? r.title, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: r.at,
  });
  await sql`UPDATE articles SET discovered_at = ${r.at}, timeline_at = ${r.at}, grouped_at = now() WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, subjects, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', ${r.category ?? "ai-models"}, ${r.title}, ${`摘要 ${n}`}, ${r.score ?? 80}, ${r.selected ?? true}, ${r.subjects ?? []}, ${[r.category === "ai-products" ? "产品更新" : r.category === "paper" ? "论文/研究" : r.category === "tip" ? "教程/实践" : r.category === "industry" ? "行业动态" : r.category === "opinion" ? "大佬观点" : "模型发布", ...(r.tags ?? [])]})`;
  if (r.fact) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${r.fact}, ${articleId}, 'report')`;
  await publishArticle(articleId, { releasedAt: new Date(r.at.getTime() + 60_000) });
  return articleId;
}

async function story(title: string): Promise<{ id: number; publicId: string }> {
  const publicId = randomUUID();
  const [s] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${title}, now(), now()) RETURNING id`;
  return { id: s!.id, publicId };
}

async function fact(storyId: number | null, title: string): Promise<number> {
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-${randomUUID()}`}, ${storyId}, ${title}) RETURNING id`;
  return f!.id;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
const page = async (slug: string, p = 1) => {
  const data = await loadTopicPage(slug, p, new Date());
  assert.ok(data, `${slug} page ${p}`);
  return data;
};
/** Every article of a topic, over all its pages. */
async function members(slug: string): Promise<string[]> {
  const first = await page(slug);
  const out = ids(first.items);
  for (let p = 2; p <= first.pageCount; p++) out.push(...ids((await page(slug, p)).items));
  return out;
}

test("a company topic takes the articles about it, not the ones that only mention it", async () => {
  const about = await report({ at: hoursAgo(30), title: `Claude Code 推出插件 ${T}`, subjects: ["anthropic"] });
  const product = await report({ at: hoursAgo(31), title: `Sonnet 新版上线 ${T}`, subjects: ["anthropic"] });
  const english = await report({ at: hoursAgo(32), title: `新模型发布 ${T}`, originalTitle: `Anthropic launches a model ${T}`, subjects: ["anthropic", "openai"] });
  const subpoena = await report({ at: hoursAgo(33), title: `加州检察长向 OpenAI 发出传票 ${T}`, subjects: ["openai", "anthropic", "hugging-face"] });
  const lowerCase = await report({ at: hoursAgo(34), title: `openai 公布新的安全框架 ${T}`, subjects: ["openai", "anthropic"] });
  const pact = await report({ at: hoursAgo(35), title: `二十余家科技公司签署安全协议 ${T}`, subjects: ["openai", "anthropic", "google"] });
  const metadata = await report({ at: hoursAgo(36), title: `Metadata 标准发布，OpenAI 参与 ${T}`, subjects: ["meta", "openai"] });
  const adjacent = await report({ at: hoursAgo(37), title: `发布Meta的新模型 ${T}`, subjects: ["meta", "openai"] });
  const headline = await report({ at: hoursAgo(38), title: `Anthropic 被一篇盘点提到 ${T}`, subjects: ["google"] });
  const agent = await report({ at: hoursAgo(39), title: `智能体框架发布 ${T}`, tags: ["Agent"] });

  const anthropic = await members("anthropic");
  for (const id of [about, product, english]) assert.ok(anthropic.includes(id), "about Anthropic");
  for (const id of [subpoena, lowerCase, pact, headline]) assert.ok(!anthropic.includes(id), "only mentions Anthropic");
  const openai = await members("openai");
  for (const id of [subpoena, lowerCase, metadata]) assert.ok(openai.includes(id), "about OpenAI");
  for (const id of [english, pact]) assert.ok(!openai.includes(id), "only mentions OpenAI");
  const meta = await members("meta");
  assert.ok(meta.includes(adjacent), "Meta next to Chinese text");
  assert.ok(!meta.includes(metadata), "Metadata is not Meta");
  assert.ok((await members("agent")).includes(agent), "a technical direction takes its tag");

  // The article page names the topics it belongs to.
  const topicsOf = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
    return (JSON.parse(res.body) as { topics: Array<{ slug: string }> }).topics.map((t) => t.slug);
  };
  assert.deepEqual(await topicsOf(about), ["anthropic", "model-releases"]);
  assert.deepEqual(await topicsOf(subpoena), ["openai", "model-releases"]);
  assert.deepEqual(await topicsOf(pact), ["model-releases"]);
  assert.deepEqual(await topicsOf(agent), ["agent", "model-releases"]);
});

test("the chronicle keeps each month's most important events, once each, in Beijing months", async () => {
  // The 1st of last month, 00:30 in Beijing (16:30 UTC the day before).
  const today = beijingDate(Date.now());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const firstOfLastMonth = new Date(`${lastMonth}-01T00:30:00+08:00`);
  const at = (minutes: number) => new Date(firstOfLastMonth.getTime() + minutes * 60_000);

  const launch = await story(`推理模型 V9 发布 ${T}`);
  const launchFact = await fact(launch.id, "发布 V9");
  const official = await report({ source: OFFICIAL, at: at(0), title: `推理模型 V9 发布 ${T}`, tags: ["推理"], score: 95, fact: launchFact });
  await report({ source: OTHER, at: at(5), title: `媒体：推理模型 V9 上线 ${T}`, tags: ["推理"], score: 70, fact: launchFact });
  const gone = await report({ source: MEDIA, at: at(6), title: `撤回的报道：推理模型 V9 ${T}`, tags: ["推理"], score: 70, fact: launchFact });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${gone}`;
  // A second development of the same story the same month.
  const followFact = await fact(launch.id, "V9 开源权重");
  await report({ at: at(600), title: `推理模型 V9 权重开源 ${T}`, tags: ["推理"], score: 60, fact: followFact });
  const minor: string[] = [];
  // Five more eligible research results of lower importance; the
  // latest one is the least important.
  for (let i = 0; i < 5; i++) minor.push(await report({ at: at(1000 + i * 60), title: `推理小进展 ${i} ${T}`, tags: ["推理"], score: 85 - i, category: "paper" }));

  const data = await page("reasoning");
  const month = data.chronicle.find((c) => c.month === lastMonth);
  assert.ok(month, "the 1st at 00:30 Beijing time belongs to its own month");
  const listed = month.events.map((e) => e.id);
  assert.equal(month.events.length, 5, "five events a month");
  assert.equal(listed.filter((id) => id === official).length, 1, "the story once, by its most important report");
  assert.ok(!listed.includes(minor[4]!), "the least important event drops out, though it is the latest");
  const lead = month.events.find((e) => e.id === official)!;
  assert.equal(lead.href, `/story/${launch.publicId}`, "an event with a public story links to it");
  assert.ok(month.events.find((e) => e.id === minor[0])!.href.startsWith("/items/"), "an event without a story links to the article");
  assert.deepEqual(listed, [...month.events].sort((a, b) => b.at.localeCompare(a.at)).map((e) => e.id), "newest first within a month");
  assert.equal(month.events.find((e) => e.id === minor[0])?.kind, "research", "a direction keeps substantial research");
  assert.deepEqual(await topicsOfStory(launch.id), [{ slug: "reasoning", name: "推理能力" }, { slug: "model-releases", name: "模型发布" }], "the story page names the topic of its reports");
});

test("a company's band prioritizes model and product launches over commentary and research", async () => {
  const today = beijingDate(Date.now());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const at = (day: number) => new Date(`${lastMonth}-${String(day).padStart(2, "0")}T12:00:00+08:00`);
  const zhipu = { subjects: ["zhipu"] };
  const model = await report({ ...zhipu, at: at(3), title: `智谱发布 GLM-6 ${T}`, category: "ai-models", score: 90 });
  const product = await report({ ...zhipu, at: at(5), title: `智谱上线新应用 ${T}`, category: "ai-products", score: 85 });
  const news = await report({ ...zhipu, at: at(7), title: `智谱完成新一轮融资 ${T}`, category: "industry", score: 80 });
  const research = await report({ ...zhipu, source: ZHIPU_BLOG, at: at(9), title: `智谱发布自研训练方法论文 ${T}`, category: "paper", score: 95 });
  const tutorial = await report({ ...zhipu, source: ZHIPU_BLOG, at: at(11), title: `智谱 GLM 提示词指南 ${T}`, category: "tip", score: 99 });
  const commentary = await report({ ...zhipu, at: at(13), title: `评论：智谱的路线之争 ${T}`, category: "opinion", score: 98 });
  const othersResearch = await report({ ...zhipu, source: OFFICIAL, at: at(15), title: `另一家机构测评智谱模型的论文 ${T}`, category: "paper", score: 97 });

  const data = await page("zhipu");
  assert.deepEqual(data.chronicle, [], "a company has its band instead of the monthly rail");
  const month = data.milestones.filter((ms) => ms.date.startsWith(lastMonth));
  const listed = month.map((ms) => ms.href);
  for (const id of [tutorial, commentary, othersResearch, research]) assert.ok(!listed.includes(`/items/${id}`), "no tutorials, nor others' commentary or research");
  assert.deepEqual([...listed].sort(), [model, product].map((id) => `/items/${id}`).sort(), "models and products; ordinary industry news does not fill an empty slot");
  assert.ok(!listed.includes(`/items/${news}`));
  assert.deepEqual(month.map((ms) => ms.kind), ["model", "product"], "oldest first, each with its kind");
  assert.deepEqual(month.map((ms) => ms.major), [false, false], "nothing picked up automatically is set in bold");
  assert.equal((await page("reasoning")).milestones.length, 0, "a direction has its rail, not a band");
});

test("a cross-month event keeps its first date while all selected progress stays readable", async () => {
  const current = beijingDate(Date.now()).slice(0, 7);
  const after = new Date(new Date(`${current}-01T00:00:00+08:00`).getTime() - 3600_000);
  const representativeMonth = beijingDate(after).slice(0, 7);
  const before = new Date(new Date(`${representativeMonth}-01T00:00:00+08:00`).getTime() - 3600_000);
  const launch = await story(`DeepSeek 工具发布 ${T}`);
  const originalFact = await fact(launch.id, "正式发布");
  const followFact = await fact(launch.id, "后续报道");
  const independent = await story(`DeepSeek 独立进展 ${T}`);
  const independentFact = await fact(independent.id, "另一件事");
  const common = { subjects: ["deepseek"], tags: ["MCP/工具调用"] };
  const earlier = await report({ ...common, at: before, title: `DeepSeek 发布工具 ${T}`, score: 80, fact: originalFact });
  const representative = await report({ ...common, at: after, title: `DeepSeek 工具发布详细报道 ${T}`, score: 95, fact: followFact });
  const other = await report({ ...common, at: after, title: `DeepSeek 另一项独立工具进展 ${T}`, score: 80, fact: independentFact });

  for (const slug of ["deepseek", "mcp"]) {
    const data = await page(slug);
    const entries = data.topic.group === "company"
      ? data.milestones.map((m) => ({ href: m.href, title: m.headline, month: m.date.slice(0, 7) }))
      : data.chronicle.flatMap((m) => m.events.map((e) => ({ href: e.href, title: e.title, month: m.month })));
    const kept = entries.filter((e) => e.href === `/story/${launch.publicId}`);
    assert.deepEqual(kept, [{ href: `/story/${launch.publicId}`, title: `DeepSeek 工具发布详细报道 ${T}`, month: beijingDate(before).slice(0, 7) }], `${slug}: one event, the earliest qualifying publication`);
    assert.ok(entries.some((e) => e.href === `/story/${independent.publicId}`), "a different event remains independent");
    const selected = await members(slug);
    for (const id of [earlier, representative, other]) assert.ok(selected.includes(id), "selected progress is not removed by chronicle deduplication");
  }
});

test("withdrawn articles stay out of lists, counts and the chronicle band", async () => {
  const kept = await report({ at: hoursAgo(5), title: `Kimi 发布新模型 ${T}`, subjects: ["kimi"] });
  const withdrawn = await report({ at: hoursAgo(4), title: `Kimi 撤回的消息 ${T}`, subjects: ["kimi"] });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;

  const data = await page("kimi");
  assert.deepEqual(ids(data.items), [kept]);
  assert.equal(data.topic.total, 1);
  assert.deepEqual(data.milestones.map((m) => m.href), [`/items/${kept}`], "the chronicle band");
  const summary = (await listTopicSummaries()).topics.find((t) => t.slug === "kimi")!;
  assert.equal(summary.latest?.title, `Kimi 发布新模型 ${T}`, "the index shows the newest public article");
});

test("every topic has a page; unknown topics and pages past the end have none", async () => {
  const empty = await page("cursor");
  assert.equal(empty.topic.indexable, false, "a topic without content is not indexed");
  assert.deepEqual(empty.items, []);
  assert.equal(await loadTopicPage("not-a-topic", 1, new Date()), null);
  assert.equal(await loadTopicPage("cursor", 2, new Date()), null);
  const index = await app.inject({ method: "GET", url: "/api/site/topics" });
  const body = JSON.parse(index.body) as { groups: Array<{ key: string }>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.groups.map((g) => g.key), ["company", "field", "genre"]);
  assert.equal(body.topics.length, 38);
});
