// Failure modes: a duplicate loses the official representative slot; an already-covered follow-up
// still takes a fresh selected slot; unseen/pending reports are treated as previously selected;
// a roundup invents a fact to suppress overlap; missing value output silently approves publication;
// a later no-op grouping erases a prior low-increment decision; a material revision silently approves
// a rejected follow-up or cannot regain its slot after adding evidence. Older confirmed identities
// must not be reevaluated merely because they predate the value field. Prompts use real samples.
// A duplicate of a fact rejected for low increment must not gain a first selected seat merely by
// sharing its identity or URL; better reporting of an unseen fact can still become its first pick.
// A launch selected before the identity window is forgotten, so an official re-introduction weeks
// later takes a fresh selected seat (and a push) as if it were new.
// One piece of news, one card (events/cards.ts): a report the judge calls a development of a fact's
// first report opens a second card for news already on screen; a report joins a fact without a card
// while another fact holds the card; history and composites, which have no fact, sit next to the card
// that told the same news; a real development, or a pair only one model calls the same, folds and
// hides news; a card out of range or a report that will not be selected costs paid calls; a failed
// call lets the duplicate out; a report an editor took out still merges facts; the owner's post and
// article show twice, or the post goes while the article is not shown; an independent source loses
// its card; a revision brings back a report that stayed out.
import { embeddingsStub, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { candidateViews } from "@aihot/backend/events/recall";
import { BatchSchema } from "@aihot/backend/events/relate";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { setVisibility } from "@aihot/backend/admin/content";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";

const sourceId = `news-value-${tag()}`;
const ownArticles = `${sourceId}-own-articles`, ownPosts = `${sourceId}-own-posts`;
/** What each model answers about a pair, where it differs from `relation`. */
let pairAnswers: { deepseek: string; mimo: string } | null = null;
let pairFails = false;
let pairCalls = 0;
let relation = "SAME_STORY";
let sameOccurrenceTitle: string | null = null;
let selection: unknown = { addsValue: true, reason: "明确的新结果" };
const users: string[] = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const user = String(body.messages.at(-1).content);
  users.push(user);
  const ids = [...user.matchAll(/【候选 (C\d+)】/g)].map(m => m[1]);
  const matching = new Set([...user.matchAll(/【候选 (C\d+)】（该事实已有 \d+ 篇报道；事实标题：(.*)）/g)]
    .filter(m => m[2] === sameOccurrenceTitle).map(m => m[1]));
  if (user.includes("报道 A")) {
    pairCalls += 1;
    if (pairFails) return { choices: [{ message: { content: "不是 JSON" } }] };
  }
  const pairRelation = !pairAnswers ? relation : String(body.model).includes("mimo") ? pairAnswers.mimo : pairAnswers.deepseek;
  const answer = user.includes("报道 A")
    ? { a: "a", b: "b", relation: pairRelation, confidence: 1, difference: "" }
    : { query: "当前动作", decisions: ids.map(id => ({ id,
      relation: sameOccurrenceTitle ? matching.has(id) ? "SAME_OCCURRENCE" : "UNRELATED" : relation, confidence: 1, note: "" })), selection };
  return { choices: [{ message: { content: JSON.stringify(answer) } }] };
});
for (const name of ["DEEPSEEK", "XIAOMI_MIMO"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "test-key";
}
const embeddings = await embeddingsStub();
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES
    (${sourceId},'News value','rss','T1','editorial','2100-01-01'),
    (${ownArticles},'Owner articles','mp_account','T1_5','editorial','2100-01-01'),
    (${ownPosts},'Owner posts','x_search','T1_5','editorial','2100-01-01')`;
  installModules([{ name: "test-owner", independentSelectedSources: [ownArticles], independentSelectedEchoes: { [ownPosts]: ownArticles } }]);
});
after(async () => { installModules([]); await provider.close(); await embeddings.close(); await stopBoss(); await closeDb(); });
let familyIndex = 0;
const family = () => Array.from({ length: 24 }, (_, i) => String.fromCharCode(0x3400 + familyIndex * 30 + i)).join("") + (++familyIndex, "");
async function report(text: string, scope = "single", selected = true, from = sourceId, publishedAt = new Date()) {
  const { articleId } = await upsertMaterial({ sourceId: from, url: `https://example.org/value/${randomUUID()}`, title: text,
    bodyText: text, bodyStatus: "ok", via: "fetch", publishedAt });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,category,score,selected,output)
    VALUES(${articleId},1,'rule','pass',${text},${text},'ai-products',80,${selected},${sql.json({ scope, fact: scope === "composite" ? null : { title: text, subject: text, action: "发布", object: text } })})`;
  await publishArticle(articleId);
  return articleId;
}
async function root(text: string, selected = true) {
  const id = await report(text, "single", selected);
  const before = provider.hits();
  const result = await groupArticle(id);
  assert.equal(provider.hits(), before, "no candidates need no extra judgement call");
  await releasedMinuteAgo(id);
  return { id, result };
}
/** Released a minute ago: a later reader still sees it as prior coverage when the VM's clock steps back (on the CI VMs by as much as 0.4 s). */
const releasedMinuteAgo = (id: string) => sql`UPDATE publications SET visible_after = visible_after - interval '1 minute' WHERE article_id = ${id}`;
async function state(id: string) {
  return (await sql`SELECT a.selection_adds_value,a.selection_value_reason,a.grouping_status,p.selected,p.eligible,p.fact_id
    FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.id=${id}`)[0]!;
}

test("value output is required and boolean, never a silent approval", () => {
  const base = { query: "fact", decisions: [] };
  assert.equal(BatchSchema.safeParse(base).success, false);
  assert.equal(BatchSchema.safeParse({ ...base, selection: { addsValue: "true", reason: "" } }).success, false);
  assert.equal(BatchSchema.safeParse({ ...base, selection: { addsValue: false } }).success, false);
  assert.equal(BatchSchema.safeParse({ ...base, selection: { addsValue: true, reason: "不同发生" } }).success, true);
});

test("same-fact reports remain eligible to replace the representative despite no new information", async () => {
  const text = family();
  const first = await root(text);
  relation = "SAME_OCCURRENCE";
  selection = { addsValue: false, reason: "相同发布" };
  const id = await report(text);
  assert.equal((await groupArticle(id)).factId, first.result.factId);
  const row = await state(id);
  assert.equal(row.selection_adds_value, true);
  assert.equal(row.selected, true);
});

for (const sameUrl of [false, true]) test(`a ${sameUrl ? "same-url" : "same-fact"} copy cannot revive a low-increment fact without new value`, async () => {
  const text = family();
  await root(text);
  relation = "SAME_STORY";
  selection = { addsValue: false, reason: "旧能力已被首发报道覆盖" };
  const rejected = await report(text + "再次讲解");
  const previous = await groupArticle(rejected);
  assert.equal((await state(rejected)).selected, false);
  const id = await report(text + "再次讲解");
  if (sameUrl) await sql`UPDATE articles SET url=(SELECT url FROM articles WHERE id=${rejected}) WHERE id=${id}`;
  relation = "SAME_OCCURRENCE";
  sameOccurrenceTitle = text + "再次讲解";
  const calls = provider.hits();
  try {
    const result = await groupArticle(id);
    assert.deepEqual([result.verdict,result.factId], [sameUrl ? "same-url" : "same-fact",previous.factId]);
    assert.deepEqual([(await state(id)).selection_adds_value,(await state(id)).selected], [false,false]);
    assert.ok(provider.hits() > calls, "an unseen target fact still compares with previously selected coverage");
  } finally { sameOccurrenceTitle = null; }
});

for (const alreadySelected of [false, true]) test(`a same-url report can ${alreadySelected ? "replace a selected representative without a call" : "be the first selected report of an unseen fact"}`, async () => {
  const text = family();
  const first = await root(text, alreadySelected);
  const id = await report(text);
  await sql`UPDATE articles SET url=(SELECT url FROM articles WHERE id=${first.id}) WHERE id=${id}`;
  selection = { addsValue: true, reason: "此前未精选这条新闻，当前报道有阅读价值" };
  relation = "SAME_OCCURRENCE";
  const calls = provider.hits();
  const result = await groupArticle(id);
  assert.deepEqual([result.verdict,result.factId], ["same-url",first.result.factId]);
  assert.equal((await state(id)).selected, true);
  assert.equal(provider.hits(), calls + (alreadySelected ? 0 : 1));
});

test("a low-increment follow-up stays a distinct fact in all content without a selected slot", async () => {
  const text = family();
  const first = await root(text);
  relation = "SAME_STORY";
  selection = { addsValue: false, reason: "仅重复此前披露的能力" };
  const id = await report(text + "再介绍");
  const result = await groupArticle(id);
  assert.equal(result.storyId, first.result.storyId);
  assert.notEqual(result.factId, first.result.factId);
  const row = await state(id);
  assert.deepEqual([row.selection_adds_value,row.selected,row.eligible], [false,false,true]);
  assert.equal((await groupArticle(id)).verdict, "kept");
  assert.equal((await state(id)).selection_adds_value, false, "a no-op retry preserves its value decision");
});

test("a material revision rechecks value in the same batch while keeping its confirmed fact", async () => {
  const text = family();
  await root(text);
  relation = "SAME_STORY";
  selection = { addsValue: false, reason: "重复介绍" };
  const id = await report(text + "讲解");
  const original = await groupArticle(id);
  const [article] = await sql`SELECT url,published_at FROM articles WHERE id=${id}`;
  for (const [revision, addsValue] of [[2, false], [3, true]] as const) {
    const revised = text + (addsValue ? "独立测得新的评测结果" : "调整措辞后的讲解");
    await upsertMaterial({ sourceId, url: article!.url, title: revised, bodyText: revised,
      bodyStatus: "ok", via: "fetch", publishedAt: article!.published_at });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,category,score,selected,output)
      VALUES(${id},${revision},'rule','pass',${revised},${revised},'ai-products',80,true,
        ${sql.json({ scope: "single", fact: { title: revised, subject: text, action: "介绍", object: text } })})`;
    assert.deepEqual([(await state(id)).grouping_status,(await state(id)).selected], ["pending",false]);
    selection = { addsValue, reason: addsValue ? "补充了新测量结果" : "仅措辞变化" };
    relation = "UNRELATED"; // The new value judgement cannot move its established identity.
    const prompts = users.length;
    const result = await groupArticle(id);
    assert.equal(users.slice(prompts).filter((user) => !user.includes("报道 A")).length, 1, "one existing batch judges the replacement revision");
    assert.deepEqual([result.verdict,result.factId,result.storyId], ["kept",original.factId,original.storyId]);
    assert.deepEqual([(await state(id)).selection_adds_value,(await state(id)).selected], [addsValue,addsValue]);
    const calls = provider.hits();
    await groupArticle(id);
    assert.equal(provider.hits(), calls, "a completed revision keeps its value without another call");
  }
});

test("an older confirmed membership with no value field keeps its existing eligibility", async () => {
  const text = family();
  const first = await root(text);
  await sql`UPDATE articles SET selection_adds_value=NULL,selection_value_reason=NULL WHERE id=${first.id}`;
  const calls = provider.hits();
  assert.equal((await groupArticle(first.id)).verdict, "kept");
  assert.equal(provider.hits(), calls);
  assert.equal((await state(first.id)).selected, true);
});

test("an independent evaluation remains selected as a new fact", async () => {
  const text = family();
  const first = await root(text);
  relation = "SAME_STORY";
  selection = { addsValue: true, reason: "独立评测首次给出结果" };
  const id = await report(text + "新评测");
  // Failure mode: a short generated summary omits the source's independent new evidence, so the
  // existing batch can never assess it. Assert the stored input reaches that actual provider call.
  const sourceEvidence = `${text} 的原文实测：Sticky Sessions 保留会话状态，Endpoint Candidates 分阶段验证新端点。`;
  await sql`UPDATE articles SET body_text=${sourceEvidence} WHERE id=${id}`;
  const result = await groupArticle(id);
  assert.notEqual(result.factId, first.result.factId);
  assert.equal((await state(id)).selected, true);
  assert.ok(users.some((user) => user.includes(sourceEvidence)), "the query's saved source evidence must reach the value judgement");
});

test("a roundup can lose its selected slot while retaining only mention links", async () => {
  const text = family();
  const first = await root(text);
  relation = "ROUNDUP";
  selection = { addsValue: false, reason: "总览没有超出已选报道的信息" };
  const id = await report(text + "总览", "composite");
  assert.equal((await groupArticle(id)).verdict, "roundup");
  assert.deepEqual((await sql`SELECT role FROM fact_articles WHERE article_id=${id} AND fact_id=${first.result.factId!}`).map(r => r.role), ["mention"]);
  const row = await state(id);
  assert.deepEqual([row.selection_adds_value,row.selected,row.eligible,row.fact_id], [false,false,true,null]);
});

// Failure modes: a selected composite has no fact, so its later single-item retelling misses prior
// coverage; or reading-only coverage gets forged into a fact/merge candidate. A terse public summary
// must not erase concrete capabilities already disclosed in the saved source. New evidence still
// deserves selection, and unpublished/unselected/out-of-window material is not reader coverage.
for (const addsValue of [false, true]) test(`a selected composite supplies reading coverage for a ${addsValue ? "new result" : "retelling"} without becoming a fact`, async () => {
  const text = family();
  const background = await report(text + "综合首发", "composite");
  await groupArticle(background);
  await releasedMinuteAgo(background);
  assert.deepEqual([(await state(background)).selected,(await state(background)).fact_id], [true,null]);
  const fullSummary = text + "。" + "已公开能力说明，".repeat(80) + "末项功能支持输出透明图层";
  await sql`UPDATE publications SET summary=${fullSummary} WHERE article_id=${background}`;
  await sql`UPDATE articles SET body_text=${text + "首发原文。" + "原文已披露的其他能力。".repeat(200) + "原文核心功能：可调参数、自动资源和多人联机"} WHERE id=${background}`;
  relation = "SAME_OCCURRENCE"; // Reading context must never be turned into an identity candidate.
  selection = { addsValue, reason: addsValue ? "给出原首发没有的新结果" : "重述综合首发已经披露的能力" };
  const id = await report(text + (addsValue ? "独立新评测" : "单项再次讲解"));
  const calls = provider.hits();
  const result = await groupArticle(id);
  assert.equal((await state(id)).selected, addsValue);
  assert.equal(provider.hits(), calls + 1, "reading coverage is judged in the existing batch with zero fact candidates");
  assert.ok(users.at(-1)!.includes(text + "综合首发"));
  assert.ok(users.at(-1)!.includes("末项功能支持输出透明图层"), "the end of a public composite summary remains readable");
  assert.ok(users.at(-1)!.includes("原文核心功能：可调参数、自动资源和多人联机"), "saved original evidence covers facts omitted by a terse summary");
  assert.doesNotMatch(users.at(-1)!, /【候选 C\d+】/);
  assert.equal(result.verdict, "new-story", "the new report owns its identity independently of the reading context");
  assert.equal((await state(background)).fact_id, null);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${background}`).length, 0);
});

test("reading-only context excludes unselected, nonpublic and old reports", async () => {
  for (const unavailable of ["unselected", "withdrawn", "old"] as const) {
    const text = family();
    const background = await report(text + "综合首发", "composite");
    await groupArticle(background);
    if (unavailable === "unselected") await sql`UPDATE publications SET selected=false WHERE article_id=${background}`;
    if (unavailable === "withdrawn") await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${background}`;
    if (unavailable === "old") await sql`UPDATE publications SET discovered_at=now()-interval '61 days', timeline_at=now()-interval '61 days' WHERE article_id=${background}`;
    selection = { addsValue: false, reason: "不能把不可见资料算作读者已看过" };
    const id = await report(text + "报道");
    const calls = provider.hits();
    await groupArticle(id);
    assert.equal(provider.hits(), calls, unavailable);
    assert.equal((await state(id)).selected, true, unavailable);
  }
});

/** Discovered `days` ago: out of the identity window, still in front of readers who saw it then. */
const age = async (id: string, days: number) => {
  await sql`UPDATE articles SET discovered_at=now()-make_interval(days => ${days}) WHERE id=${id}`;
  await sql`UPDATE publications SET discovered_at=now()-make_interval(days => ${days}) WHERE article_id=${id}`;
};

test("a launch selected before the identity window is still reader coverage for a re-introduction", async () => {
  const text = family();
  const launch = await root(text + "首发");
  await age(launch.id, 15);
  relation = "SAME_OCCURRENCE"; // Reading context must never be turned into an identity candidate.
  selection = { addsValue: false, reason: "再次介绍首发已经披露的能力" };
  const id = await report(text + "再次介绍用法");
  const calls = provider.hits();
  const result = await groupArticle(id);
  assert.equal(provider.hits(), calls + 1, "judged in the batch call");
  assert.ok(users.at(-1)!.includes("已公开精选阅读背景 R1") && users.at(-1)!.includes(text + "首发"));
  assert.doesNotMatch(users.at(-1)!, /【候选 C\d+】/);
  assert.equal(result.verdict, "new-story", "identity keeps its own window");
  assert.deepEqual([(await state(id)).selection_adds_value, (await state(id)).selected], [false, false]);
});

test("a selected fact still among the candidates is not repeated as reading context", async () => {
  const text = family();
  const launch = await root(text + "首发");
  relation = "SAME_OCCURRENCE";
  selection = { addsValue: true, reason: "same fact" };
  const later = await report(text + "首发另一来源"); // keeps the fact in the identity window
  assert.equal((await groupArticle(later)).factId, launch.result.factId);
  await age(launch.id, 20);
  selection = { addsValue: false, reason: "已覆盖" };
  const id = await report(text + "再次介绍");
  await groupArticle(id);
  const batch = users.findLast(u => u.startsWith(`【新报道】\n标题：${text}再次介绍`))!;
  assert.match(batch, /【候选 C1】/);
  assert.doesNotMatch(batch, /阅读背景/);
});

test("unselected candidates are not prior selected coverage", async () => {
  const text = family();
  await root(text, false);
  relation = "SAME_STORY";
  selection = { addsValue: false, reason: "模型误以为候选已精选" };
  const id = await report(text + "新消息");
  await groupArticle(id);
  assert.equal((await state(id)).selection_adds_value, true);
  assert.equal((await state(id)).selected, true);
});

test("value context uses the actually selected report without replacing the identity representative", async () => {
  const text = family();
  const first = await root(text, false);
  const id = await report(text + "公开精选内容");
  relation = "SAME_OCCURRENCE";
  selection = { addsValue: true, reason: "same fact" };
  await groupArticle(id);
  await releasedMinuteAgo(id);
  const [candidate] = await candidateViews([{ factId: first.result.factId!, storyId: first.result.storyId!, factTitle: text, score: 1 }]);
  assert.equal(candidate!.report.title, text);
  assert.equal(candidate!.selected, true);
  assert.equal(candidate!.selectedReport?.title, text + "公开精选内容");
});

test("a missing value answer remains failed and cannot settle a fact", async () => {
  const text = family();
  await root(text);
  relation = "SAME_STORY";
  selection = undefined;
  const id = await report(text + "缺少答案");
  await assert.rejects(groupArticle(id), /unusable output/);
  assert.equal((await state(id)).grouping_status, "failed");
  assert.equal((await state(id)).fact_id, null);
});

/** A selected report on screen, whichever source or scope; the judge leaves it alone. */
async function card(text: string, scope = "single", from = sourceId) {
  const id = await report(text, scope, true, from);
  const result = await groupArticle(id);
  await releasedMinuteAgo(id);
  return { id, ...result };
}
/** The next report: the judge calls every candidate a development, both models see one occurrence. */
function sameNewsAhead() {
  relation = "SAME_STORY";
  sameOccurrenceTitle = null;
  selection = { addsValue: true, reason: "多了几个细节" };
  pairAnswers = { deepseek: "SAME_OCCURRENCE", mimo: "SAME_OCCURRENCE" };
  pairFails = false;
  pairCalls = 0;
}
const otherNews = (answer: string) => { pairAnswers = { deepseek: answer, mimo: answer }; };
async function cards(ids: string[]) {
  const { cards } = await loadTimeline({ channel: "all", category: null, tag: null, limit: 40, now: new Date(Date.now() + 1000) } as never);
  return cards.filter((c) => ids.includes(c.item.id)).length;
}
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

test("a report the judge calls a development of the fact's first report joins the card telling the same news", async () => {
  sameNewsAhead();
  const text = family();
  const shown = await root(text);
  const official = await report(text + "官方");
  const result = await groupArticle(official);
  assert.deepEqual([result.verdict, result.factId], ["same-card", shown.result.factId]);
  assert.deepEqual([(await state(official)).selected, (await state(official)).fact_id], [true, shown.result.factId], "it can still become the card's representative");
  assert.equal(await cards([shown.id, official]), 1);
  const [decision] = await sql<{ verdict: string; fact_id: number }[]>`SELECT verdict, fact_id FROM grouping_decisions WHERE article_id = ${official}`;
  assert.deepEqual([decision!.verdict, decision!.fact_id], ["same-card", shown.result.factId]);
});

test("a report joining a fact without a card brings that fact into the fact holding the card", async () => {
  sameNewsAhead();
  const text = family();
  const shown = await root(text);
  const quiet = await report(text + "未入选", "single", false);
  const split = await groupArticle(quiet);
  assert.notEqual(split.factId, shown.result.factId, "fixture: a second fact of the story, without a card");
  sameOccurrenceTitle = text + "未入选";
  const id = await report(text + "再报道");
  const result = await groupArticle(id);
  assert.deepEqual([result.verdict, result.factId, result.absorbed], ["same-card", shown.result.factId, { from: split.factId, moved: 1 }]);
  assert.equal((await state(quiet)).fact_id, shown.result.factId, "the split fact's other report moved too");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE fact_id = ${split.factId!}`).length, 0);
  assert.equal(await cards([shown.id, id]), 1);
});

for (const [name, answers, calls] of [
  ["a real development keeps its own card without asking the review model", { deepseek: "SAME_STORY", mimo: "SAME_OCCURRENCE" }, 1],
  ["the review model can veto: one model's answer never folds a card", { deepseek: "SAME_OCCURRENCE", mimo: "SAME_STORY" }, 2],
] as const) test(name, async () => {
  sameNewsAhead();
  const text = family();
  const shown = await root(text);
  pairAnswers = answers;
  const later = await report(text + "进展");
  pairCalls = 0;
  assert.equal((await groupArticle(later)).verdict, "new-fact-in-story");
  assert.equal(pairCalls, calls);
  assert.notEqual((await state(later)).fact_id, shown.result.factId);
  assert.equal(await cards([shown.id, later]), 2);
});

test("a card over a week away, a card on another topic and a report that will not be selected cost no comparison", async () => {
  sameNewsAhead();
  const old = family();
  const shown = await root(old);
  await sql`UPDATE publications SET timeline_at = now() - interval '8 days' WHERE article_id = ${shown.id}`;
  pairCalls = 0;
  await groupArticle(await report(old + "很久以后"));
  assert.equal(pairCalls, 0, "outside the window");
  const unseen = family();
  await root(unseen);
  pairCalls = 0;
  await groupArticle(await report(family()));
  assert.equal(pairCalls, 0, "another topic");
  await groupArticle(await report(unseen + "低分", "single", false));
  assert.equal(pairCalls, 0, "not going to be selected");
});

test("history telling the news of a card around its date stays out of selection and stays readable; with its own news it keeps its card", async () => {
  sameNewsAhead();
  const text = family();
  const shown = await root(text);
  const late = await report(text + "晚到", "single", true, sourceId, daysAgo(3));
  assert.equal((await groupArticle(late)).verdict, "historical");
  const row = await state(late);
  assert.deepEqual([row.selected, row.eligible, row.selection_adds_value, row.fact_id], [false, true, false, null]);
  assert.ok(String(row.selection_value_reason).includes(text), "the reason names the card");
  assert.equal(await cards([shown.id, late]), 1);

  otherNews("SAME_STORY");
  const own = await report(text + "另有其事", "single", true, sourceId, daysAgo(3));
  assert.equal((await groupArticle(own)).verdict, "historical");
  assert.deepEqual([(await state(own)).selected, (await state(own)).selection_value_reason], [true, "历史资料按原文时间归档"]);
});

test("a composite whose news is on a card stays out; one with news of its own keeps its card", async () => {
  sameNewsAhead();
  const text = family();
  await root(text);
  const copy = await report(text + "综合稿", "composite");
  assert.equal((await groupArticle(copy)).verdict, "roundup");
  assert.deepEqual([(await state(copy)).selected, (await state(copy)).selection_adds_value, (await state(copy)).fact_id], [false, false, null]);

  otherNews("ROUNDUP");
  const digest = await report(text + "另一篇综合稿", "composite");
  assert.equal((await groupArticle(digest)).verdict, "roundup");
  assert.equal((await state(digest)).selected, true);
});

test("a report with the news of a card that has no fact stays out, and so do later ones of its fact", async () => {
  sameNewsAhead();
  const text = family();
  otherNews("UNRELATED");
  const digest = await card(text + "综合稿", "composite");
  assert.equal((await state(digest.id)).selected, true);
  sameNewsAhead();
  const single = await report(text);
  const first = await groupArticle(single);
  assert.equal((await state(single)).selected, false);
  assert.ok(first.factId, "it keeps its identity for later reports");
  relation = "SAME_OCCURRENCE";
  const second = await report(text + "第二篇");
  assert.equal((await groupArticle(second)).factId, first.factId);
  assert.equal((await state(second)).selected, false);
});

test("a failed comparison lets no duplicate out: the report waits, and the retry settles it", async () => {
  sameNewsAhead();
  const text = family();
  const shown = await root(text);
  pairFails = true;
  const later = await report(text + "待定");
  await assert.rejects(groupArticle(later));
  assert.equal((await state(later)).selected, false);
  assert.notEqual((await state(later)).grouping_status, "complete");
  pairFails = false;
  assert.deepEqual([(await groupArticle(later)).factId, (await state(later)).selected], [shown.result.factId, true]);
});

test("a report an editor took out is compared with no card", async () => {
  sameNewsAhead();
  const text = family();
  await root(text);
  const hidden = await report(text + "已撤下");
  await setVisibility(hidden, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  pairCalls = 0;
  const result = await groupArticle(hidden);
  assert.equal(pairCalls, 0);
  assert.notEqual(result.verdict, "same-card");
});

test("an independent source keeps its card and is no target for ordinary reports", async () => {
  sameNewsAhead();
  const text = family();
  const article = await card(text, "single", ownArticles);
  pairCalls = 0;
  const official = await report(text + "官方");
  const result = await groupArticle(official);
  assert.equal(pairCalls, 0, "ordinary reports do not fold into an independent card");
  assert.notEqual(result.verdict, "same-card");
  assert.deepEqual([(await state(official)).selected, (await state(article.id)).selected], [true, true]);

  const another = family();
  const shown = await root(another);
  pairCalls = 0;
  const own = await report(another + "公众号", "single", true, ownArticles);
  await groupArticle(own);
  assert.equal(pairCalls, 0, "only the author's own posts are compared");
  assert.deepEqual([(await state(own)).selected, (await state(shown.id)).selected], [true, true]);
});

test("the owner's post on the same news gives way to their article, whichever came first and whatever fact they share", async () => {
  sameNewsAhead();
  const shared = family();
  const article = await card(shared, "single", ownArticles);
  relation = "SAME_OCCURRENCE";
  const sameFact = await report(shared + "帖子", "single", true, ownPosts);
  assert.equal((await groupArticle(sameFact)).factId, article.factId, "fixture: the post joins the article's fact");
  assert.deepEqual([(await state(sameFact)).selected, (await state(article.id)).selected], [false, true]);

  sameNewsAhead();
  const apart = family();
  const articleApart = await card(apart, "single", ownArticles);
  const post = await report(apart + "帖子", "single", true, ownPosts);
  await groupArticle(post);
  assert.deepEqual([(await state(post)).selected, (await state(articleApart.id)).selected], [false, true]);

  for (const [scope, publishedAt] of [["single", new Date()], ["composite", new Date()], ["single", daysAgo(3)]] as const) {
    sameNewsAhead();
    const text = family();
    otherNews("UNRELATED");
    const earlier = await card(text, "single", ownPosts);
    assert.equal((await state(earlier.id)).selected, true);
    sameNewsAhead();
    const later = await report(text + "文章", scope, true, ownArticles, publishedAt);
    const result = await groupArticle(later);
    assert.deepEqual([(await state(earlier.id)).selected, (await state(later)).selected, result.retired], [false, true, [earlier.id]], `${scope} ${publishedAt}`);
    assert.ok(String((await state(earlier.id)).selection_value_reason).includes(text));
  }
});

test("the owner's post gives way even when ordinary reports already hold the fact's card", async () => {
  sameNewsAhead();
  const text = family();
  const article = await card(text, "single", ownArticles);
  relation = "SAME_OCCURRENCE";
  const ordinary = await report(text + "普通报道");
  assert.equal((await groupArticle(ordinary)).factId, article.factId, "fixture: article and report share the fact");
  await releasedMinuteAgo(ordinary);
  const post = await report(text + "帖子", "single", true, ownPosts);
  pairCalls = 0;
  await groupArticle(post);
  assert.ok(pairCalls > 0, "the post compares with the article although the fact has a card");
  assert.deepEqual([(await state(post)).selected, (await state(ordinary)).selected, (await state(article.id)).selected], [false, true, true]);
});

test("a failed comparison holds the owner's article back: the post stays alone, and the retry replaces it", async () => {
  sameNewsAhead();
  const text = family();
  otherNews("UNRELATED");
  const post = await card(text, "single", ownPosts);
  sameNewsAhead();
  pairFails = true;
  const article = await report(text + "文章", "single", true, ownArticles);
  await assert.rejects(groupArticle(article));
  assert.deepEqual([(await state(article)).selected, (await state(post.id)).selected], [false, true]);
  assert.notEqual((await state(article)).grouping_status, "complete", "the repair sweep can still find it");
  pairFails = false;
  const retried = await groupArticle(article);
  assert.deepEqual([retried.retired, (await state(article)).selected, (await state(post.id)).selected], [[post.id], true, false]);
});

test("a revision that lets the owner's article into selection replaces their post, even when the fact already shows it", async () => {
  sameNewsAhead();
  const text = family();
  const article = await report(text, "single", false, ownArticles);
  const founded = await groupArticle(article);
  relation = "SAME_OCCURRENCE";
  otherNews("UNRELATED");
  const post = await report(text + "帖子", "single", true, ownPosts);
  assert.equal((await groupArticle(post)).factId, founded.factId, "fixture: the post is the fact's card while the article is not selected");
  await releasedMinuteAgo(post);
  assert.deepEqual([(await state(article)).selected, (await state(post)).selected], [false, true]);

  sameNewsAhead();
  relation = "SAME_OCCURRENCE";
  const [row] = await sql<{ url: string }[]>`SELECT url FROM articles WHERE id = ${article}`;
  const revised = text + "文章补全";
  await upsertMaterial({ sourceId: ownArticles, url: row!.url, title: revised, bodyText: revised, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,category,score,selected,output)
    VALUES(${article},2,'rule','pass',${revised},${revised},'ai-products',80,true,${sql.json({ scope: "single", fact: { title: revised, subject: text, action: "发布", object: text } })})`;
  const result = await groupArticle(article);
  assert.deepEqual([result.verdict, result.retired], ["kept", [post]]);
  assert.deepEqual([(await state(article)).selected, (await state(post)).selected], [true, false]);
});

test("the owner's post stays when the article will not be shown", async () => {
  sameNewsAhead();
  const text = family();
  otherNews("UNRELATED");
  const post = await card(text, "single", ownPosts);
  sameNewsAhead();
  const article = await report(text + "文章", "single", true, ownArticles);
  await setVisibility(article, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  await groupArticle(article);
  assert.equal((await state(post.id)).selected, true);

  const low = await report(text + "价值低的文章", "single", true, ownArticles);
  selection = { addsValue: false, reason: "没有新内容" };
  relation = "SAME_STORY";
  pairCalls = 0;
  await groupArticle(low);
  assert.equal(pairCalls, 0, "a comparison whose answer could not be used is not paid for");
  assert.deepEqual([(await state(low)).selected, (await state(post.id)).selected], [false, true]);
});

test("a revision of a report that stayed out does not bring its card back", async () => {
  sameNewsAhead();
  const text = family();
  const article = await card(text, "single", ownArticles);
  const post = await report(text + "帖子", "single", true, ownPosts);
  await groupArticle(post);
  assert.equal((await state(post)).selected, false);
  const [row] = await sql<{ url: string }[]>`SELECT url FROM articles WHERE id = ${post}`;
  const revised = text + "帖子改了措辞";
  await upsertMaterial({ sourceId: ownPosts, url: row!.url, title: revised, bodyText: revised, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,category,score,selected,output)
    VALUES(${post},2,'rule','pass',${revised},${revised},'ai-products',80,true,${sql.json({ scope: "single", fact: { title: revised, subject: text, action: "发布", object: text } })})`;
  assert.equal((await groupArticle(post)).verdict, "kept");
  assert.deepEqual([(await state(post)).selected, (await state(article.id)).selected], [false, true]);
});
