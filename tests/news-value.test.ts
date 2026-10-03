// Failure modes: a duplicate loses the official representative slot; an already-covered follow-up
// still takes a fresh selected slot; unseen/pending reports are treated as previously selected;
// a roundup invents a fact to suppress overlap; missing value output silently approves publication;
// a later no-op grouping erases a prior low-increment decision; a material revision silently approves
// a rejected follow-up or cannot regain its slot after adding evidence. Older confirmed identities
// must not be reevaluated merely because they predate the value field. Prompts use real samples.
// A duplicate of a fact rejected for low increment must not gain a first selected seat merely by
// sharing its identity or URL; better reporting of an unseen fact can still become its first pick.
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
import { stopBoss } from "@aihot/backend/jobs/queue";

const sourceId = `news-value-${tag()}`;
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
  const answer = user.includes("报道 A")
    ? { a: "a", b: "b", relation, confidence: 1, difference: "" }
    : { query: "当前动作", decisions: ids.map(id => ({ id,
      relation: sameOccurrenceTitle ? matching.has(id) ? "SAME_OCCURRENCE" : "UNRELATED" : relation, confidence: 1, note: "" })), selection };
  return { choices: [{ message: { content: JSON.stringify(answer) } }] };
});
for (const name of ["DEEPSEEK", "XIAOMI_MIMO"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "test-key";
}
const embeddings = await embeddingsStub();
before(async () => { await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${sourceId},'News value','rss','T1','editorial','2100-01-01')`; });
after(async () => { await provider.close(); await embeddings.close(); await stopBoss(); await closeDb(); });
let familyIndex = 0;
const family = () => Array.from({ length: 24 }, (_, i) => String.fromCharCode(0x3400 + familyIndex * 30 + i)).join("") + (++familyIndex, "");
async function report(text: string, scope = "single", selected = true) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/value/${randomUUID()}`, title: text,
    bodyText: text, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
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
  return { id, result };
}
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
    const calls = provider.hits();
    const result = await groupArticle(id);
    assert.equal(provider.hits(), calls + 1, "one existing batch judges the replacement revision");
    assert.deepEqual([result.verdict,result.factId,result.storyId], ["kept",original.factId,original.storyId]);
    assert.deepEqual([(await state(id)).selection_adds_value,(await state(id)).selected], [addsValue,addsValue]);
    await groupArticle(id);
    assert.equal(provider.hits(), calls + 1, "a completed revision keeps its value without another call");
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
  assert.ok(users.at(-1)!.includes(sourceEvidence), "the query's saved source evidence must reach the value judgement");
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
    if (unavailable === "old") await sql`UPDATE publications SET discovered_at=now()-interval '15 days' WHERE article_id=${background}`;
    selection = { addsValue: false, reason: "不能把不可见资料算作读者已看过" };
    const id = await report(text + "报道");
    const calls = provider.hits();
    await groupArticle(id);
    assert.equal(provider.hits(), calls, unavailable);
    assert.equal((await state(id)).selected, true, unavailable);
  }
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
