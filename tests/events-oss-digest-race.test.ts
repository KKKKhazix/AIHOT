// 用本地模型与显式门闩复现旧上下文和异步回写；不连接真实模型或依赖sleep排序。
import { gate, stub } from "./setup.ts";
import { pair, story, source, article, sourceVersion, cleanup, fixtureTag, trackStory } from "./events-oss-withdrawal-fixture.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { setVisibility, overrideFields } from "@aihot/backend/admin/content";
import { detachFromFact } from "@aihot/backend/events/corrections";
import { updateSource } from "@aihot/backend/admin/sources";
import { composeStoryDigest } from "@aihot/backend/events/digest";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { groupArticle } from "@aihot/backend/events/group";
import { loadStoryDetail } from "@aihot/backend/publication/stories";

const prompts: string[] = [];
const safe = { title: "安全的新事件标题", digest: "只依据当前可公开报道重建的安全事件综述。", latest: "安全的最新进展" };
let answer: (user: string) => unknown | Promise<unknown> = () => safe;
const provider = await stub(async (_hit, req) => {
  const user = (JSON.parse(req.body) as { messages: Array<{ content: string }> }).messages[1]!.content;
  prompts.push(user);
  const result = await answer(user);
  return { id: "synthetic", choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
let budgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  budgets = await sql`SELECT service,per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=10000,per_day=100000 WHERE service='deepseek'`;
});
after(async () => {
  await provider.close();
  try {
    await cleanup();
    for (const b of budgets) await sql`UPDATE budgets SET per_minute=${b.per_minute},per_hour=${b.per_hour},per_day=${b.per_day} WHERE service=${b.service}`;
  } finally { await stopBoss(); await closeDb(); }
});
const remove = (id: string) => setVisibility(id, { visibility: "withdrawn", version: 0, reason: "测试撤回" }, "test");
async function waitForCall(asked: { promise: Promise<void> }, run: Promise<unknown>) {
  await Promise.race([asked.promise, run.then(() => assert.fail("未通过受控模型请求，不能算作竞态复现"))]);
}

test("撤回后重建不把旧事件标题或综述重新送模型", async () => {
  for (const origin of ["model", "manual", "replay"] as const) {
    const p = await pair(`prompt-${origin}`, { origin });
    await remove(p.a);
    answer = () => safe;
    assert.equal((await composeStoryDigest(p.id)).updated, true);
    assert.ok(!prompts.at(-1)!.includes(p.marker), "实际请求不能携带被撤回的旧上下文");
    assert.ok(!JSON.stringify(await loadStoryDetail(p.id)).includes(p.marker));
  }
});

for (const change of ["withdraw", "source", "correction"]) {
  test(`模型回答期间${change}，旧结果不能重新发布`, async () => {
    const p = await pair(`race-${change}`);
    const asked = gate(); const hold = gate();
    answer = async () => { asked.open(); await hold.promise; return { title: p.marker, digest: p.marker + "已过期模型综述", latest: p.marker }; };
    const run = composeStoryDigest(p.id);
    await waitForCall(asked, run);
    try {
      if (change === "withdraw") await remove(p.a);
      else if (change === "source") await updateSource(p.sourceA, { patch: { participation_mode: "isolated" }, version: await sourceVersion(p.sourceA) }, "test");
      else await overrideFields(p.a, { fields: { title: "新的安全更正", summary: "新的安全摘要" }, reason: "测试", version: 0 }, "test");
    } finally { hold.open(); }
    assert.equal((await run).updated, false);
    assert.ok(!JSON.stringify(await loadStoryDetail(p.id)).includes(p.marker));
    const [used] = await sql`SELECT status FROM receipts WHERE purpose='story_digest' AND subject LIKE ${`story:${p.id}@%`} ORDER BY id DESC LIMIT 1`;
    assert.equal(used!.status, "completed", "已付费旧响应记为消费，不能当成已发布综述");
    answer = () => safe;
    assert.equal((await composeStoryDigest(p.id)).updated, true);
    assert.ok(!prompts.at(-1)!.includes(p.marker));
  });
}

test("生成只用当前公开可用报道，零输入不调用模型", async () => {
  const p = await pair("input-gates", { eligibleB: false });
  const pending = await article(await source(), "尚未释放的输入", { pending: true });
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${p.factId},${pending},'report')`;
  await remove(p.a);
  const hits = provider.hits();
  assert.equal((await composeStoryDigest(p.id)).updated, false);
  assert.equal(provider.hits(), hits);
  assert.ok(await loadStoryDetail(p.id), "非eligible的合法历史稿仍有事件页面");
});

test("输入缩减和旧无provenance版本强制重写，纯新增可保留已验证上下文", async () => {
  const p = await pair("provenance");
  answer = () => safe;
  assert.equal((await composeStoryDigest(p.id)).updated, true);
  const hits = provider.hits();
  assert.equal((await composeStoryDigest(p.id)).updated, false);
  assert.equal(provider.hits(), hits);
  const added = await article(p.sourceB, "新增且仍可公开的报道");
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${p.factId},${added},'report')`;
  await composeStoryDigest(p.id);
  assert.ok(prompts.at(-1)!.includes(safe.digest), "获证安全且未变的旧综述可供增量更新");
  await remove(p.a);
  await composeStoryDigest(p.id);
  assert.ok(!prompts.at(-1)!.includes(safe.digest), "集合缩减不能继续依赖旧综述");
  assert.ok(!prompts.at(-1)!.includes(p.marker));
});

test("超过40篇时分别记录全部资格guard和实际写作上下文", async () => {
  const src = await source();
  const ids: string[] = [];
  for (let i = 0; i < 42; i++) ids.push(await article(src, `有序报道${String(i).padStart(2, "0")}`));
  const st = await story(ids.map(id => ({ id })), "初始不可信标题");
  answer = () => safe;
  await composeStoryDigest(st.id);
  const [last] = await sql`SELECT article_ids,context_article_ids FROM story_digests WHERE story_id=${st.id} ORDER BY version DESC LIMIT 1`;
  assert.equal(last!.article_ids.length, 42);
  assert.deepEqual([...last!.context_article_ids].sort(), ids.slice(-40).sort());
  const hits = provider.hits();
  assert.equal((await composeStoryDigest(st.id)).updated, false);
  assert.equal(provider.hits(), hits);
});

test("两次不同输入的并发生成只提交当前世代", async () => {
  const p = await pair("concurrent");
  const firstAsked = gate(); const secondAsked = gate(); const firstHold = gate(); const secondHold = gate();
  let calls = 0;
  answer = async () => {
    const n = ++calls;
    if (n === 1) { firstAsked.open(); await firstHold.promise; return { ...safe, digest: "已经过期的第一版模型综述内容。" }; }
    secondAsked.open(); await secondHold.promise; return { ...safe, digest: "包含新增报道的当前模型综述内容。" };
  };
  const first = composeStoryDigest(p.id);
  await waitForCall(firstAsked, first);
  const added = await article(p.sourceB, "并发时加入的公开报道");
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${p.factId},${added},'report')`;
  const second = composeStoryDigest(p.id);
  await waitForCall(secondAsked, second);
  secondHold.open();
  const current = await second;
  firstHold.open();
  const stale = await first;
  assert.equal(current.updated, true);
  assert.equal(stale.updated, false);
  const [count] = await sql`SELECT count(*)::int AS n FROM story_digests WHERE story_id=${p.id}`;
  assert.equal(count!.n, 1);
});

test("撤回发生在首次归组回答之前，晚到结果不能新建可复活的旧标题", async () => {
  const shared = "某机构发布新的人工智能模型并介绍测试结果";
  const seed = await article(await source(), shared);
  await story([{ id: seed }], shared);
  const marker = `晚到撤回${fixtureTag}`;
  const a = await article(await source(), shared + marker);
  const asked = gate(); const hold = gate();
  answer = async (user) => {
    asked.open(); await hold.promise;
    return { query: "模型发布", decisions: [...user.matchAll(/【候选 (C\d+)】/g)].map(m => ({ id: m[1], relation: "UNRELATED", confidence: 0.99, note: "不同事件" })) };
  };
  const run = groupArticle(a);
  await waitForCall(asked, run);
  try { await remove(a); } finally { hold.open(); }
  await run;
  const created = await sql`SELECT f.title,st.title AS story_title FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id JOIN stories st ON st.id=f.story_id WHERE fa.article_id=${a}`;
  assert.equal(created.length, 0, "撤回时尚无membership，不能靠只清现有事件来通过");
  answer = () => safe;
});


test("归组途中更正后旧结果丢弃，下一次只用当前公开文字", async () => {
  const shared = "某机构发布新的人工智能模型并介绍测试结果";
  const marker = `待更正主张${fixtureTag}`;
  const a = await article(await source(), shared + marker);
  const asked = gate(); const hold = gate();
  answer = async (user) => { asked.open(); await hold.promise; return { query: "发布", decisions: [...user.matchAll(/【候选 (C\d+)】/g)].map(m => ({ id: m[1], relation: "UNRELATED", confidence: 0.99, note: "不同事件" })) }; };
  const run = groupArticle(a);
  await waitForCall(asked, run);
  try { await overrideFields(a, { fields: { title: shared + "安全更正", summary: "安全更正后的摘要" }, reason: "测试", version: 0 }, "test"); }
  finally { hold.open(); }
  assert.equal((await run).storyId, undefined);
  assert.equal((await sql`SELECT fact_id FROM fact_articles WHERE article_id=${a}`).length, 0);
  const retry = await groupArticle(a);
  assert.ok(retry.storyId);
  trackStory(retry.storyId!);
  assert.ok(!prompts.at(-1)!.includes(marker));
  assert.ok(!JSON.stringify(await loadStoryDetail(retry.storyId!)).includes(marker));
});

test("已撤回的排队归组不再询问模型或建立事实", async () => {
  const a = await article(await source(), "某机构发布新的人工智能模型并介绍测试结果 已撤回");
  await remove(a);
  const hits = provider.hits();
  assert.equal((await groupArticle(a)).storyId, undefined);
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT fact_id FROM fact_articles WHERE article_id=${a}`).length, 0);
});

test("合并改变世代后旧事件模型结果不能写回", async () => {
  const p = await pair("merge-race");
  const target = await pair("merge-target");
  const asked = gate(); const hold = gate();
  answer = async () => { asked.open(); await hold.promise; return safe; };
  const run = composeStoryDigest(p.id);
  await waitForCall(asked, run);
  try { await mergeStoryInto(p.id, target.id, "测试合并", "test"); }
  finally { hold.open(); }
  assert.equal((await run).updated, false);
  assert.equal((await sql`SELECT count(*)::int AS n FROM story_digests WHERE story_id=${p.id}`)[0]!.n, 0);
});


test("已移走成员的旧综述依赖仍在撤回时失效", async () => {
  const p = await pair("detached-dependency");
  answer = () => ({ title: p.marker, digest: p.marker + "形成的旧综述", latest: p.marker });
  await composeStoryDigest(p.id);
  await detachFromFact(p.a, "测试移走", "test");
  assert.equal((await sql`SELECT fact_id FROM fact_articles WHERE article_id=${p.a}`).length, 0);
  await remove(p.a);
  const current = await loadStoryDetail(p.id);
  assert.ok(current);
  assert.ok(!JSON.stringify(current).includes(p.marker));
});
