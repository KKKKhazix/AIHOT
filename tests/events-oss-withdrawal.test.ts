// 撤回一篇报道不隐藏仍合法的其他报道，也不能留下可重新公开的事件副本。
import { pair, story, source, article, rank, sourceVersion, cleanup } from "./events-oss-withdrawal-fixture.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { setVisibility, overrideFields } from "@aihot/backend/admin/content";
import { detachFromFact } from "@aihot/backend/events/corrections";
import { updateSource } from "@aihot/backend/admin/sources";
import { groupArticle } from "@aihot/backend/events/group";
import { loadStoryDetail } from "@aihot/backend/publication/stories";
import { loadHotStrip } from "@aihot/backend/publication/hot";
import { ogEtag } from "../apps/api/src/og/render.ts";
import { buildApp } from "../apps/api/src/app.ts";

const app = await buildApp();
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const client = new Client({ name: "private-withdrawal-test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(address + "/api/mcp")));
after(async () => { await client.close(); await app.close(); try { await cleanup(); } finally { await stopBoss(); await closeDb(); } });
const withdraw = (id: string, visibility: "withdrawn" | "summary-only" = "withdrawn", version = 0) => setVisibility(id, { visibility, version, reason: "测试撤回" }, "test");
const get = (url: string, etag?: string) => app.inject({ method: "GET", url, headers: etag ? { "if-none-match": etag } : {} });
async function cleanStory(p: Awaited<ReturnType<typeof pair>>) {
  for (const url of [`/api/site/stories/${p.publicId}`, `/api/v1/stories/${p.publicId}`, `/api/site/items/${p.b}`]) {
    const response = await get(url);
    assert.equal(response.statusCode, 200, url);
    assert.ok(!response.body.includes(p.marker), `${url}仍含撤回主张`);
  }
  const mcp = await client.callTool({ name: MCP_TOOL_NAMES.story, arguments: { public_id: p.publicId } });
  assert.ok(!JSON.stringify(mcp).includes(p.marker));
}

test("主次事件和预热出口同步去掉撤回主张，剩余报道不被隐藏", async () => {
  const p = await pair("all-exits", { origin: "manual" });
  const c = await article(await source(), "另一个合法公开报道");
  const secondary = await story([{ id: p.a, role: "mention" }, { id: c }], p.marker, "replay");
  const control = await pair("unaffected");
  await sql`INSERT INTO story_links(story_id,other_id,relation) VALUES(${control.id},${p.id},'related')`;
  await rank([p, { ...p, id: secondary.id, publicId: secondary.publicId }, control]);
  const before = await get(`/api/site/stories/${p.publicId}`);
  assert.ok(before.body.includes(p.marker));
  await get("/api/site/hot");
  await client.callTool({ name: MCP_TOOL_NAMES.hot, arguments: { limit: 10 } });
  const [unchanged] = await sql`SELECT title,digest,version FROM stories WHERE id=${control.id}`;
  await withdraw(p.a);
  await cleanStory(p);
  const second = await get(`/api/site/stories/${secondary.publicId}`);
  assert.equal(second.statusCode, 200);
  assert.ok(!second.body.includes(p.marker));
  for (const url of ["/api/site/hot", "/api/v1/hot-topics", "/api/site/timeline", `/api/site/stories/${control.publicId}`]) {
    const response = await get(url);
    assert.equal(response.statusCode, 200, url);
    assert.ok(!response.body.includes(p.marker), url);
  }
  assert.ok(!JSON.stringify(await loadHotStrip()).includes(p.marker));
  assert.ok(!JSON.stringify(await client.callTool({ name: MCP_TOOL_NAMES.hot, arguments: { limit: 10 } })).includes(p.marker));
  const changed = await get(`/api/site/stories/${p.publicId}`, String(before.headers.etag));
  assert.equal(changed.statusCode, 200);
  const detail = (await loadStoryDetail(p.id))!;
  const card = { kicker: detail.whyHot.rank ? `热点第 ${detail.whyHot.rank} · 事件` : "事件", title: detail.title,
    subtitle: detail.latest ?? detail.digest, meta: `${detail.sourceCount} 个来源 · ${detail.reportCount} 篇报道`, accent: detail.whyHot.rank ? "hot" as const : "teal" as const };
  assert.ok(!JSON.stringify(card).includes(p.marker));
  const og = await get(`/og/stories/${p.publicId}.png`);
  assert.equal(og.headers.etag, `"og-${ogEtag(card)}"`);
  assert.deepEqual({ ...(await sql`SELECT title,digest,version FROM stories WHERE id=${control.id}`)[0] }, { ...unchanged });
  const [audit] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject=${`story:${p.id}`} AND before::text LIKE ${'%' + p.marker + '%'}`;
  assert.ok(audit!.n > 0, "旧人工文字保留在私有审计，而非被永久销毁");
});

test("summary-only退出事件输入，但自身合法摘要页仍存在", async () => {
  const p = await pair("summary-only");
  await withdraw(p.a, "summary-only");
  await cleanStory(p);
  const own = await get(`/api/site/items/${p.a}`);
  assert.equal(own.statusCode, 200);
  assert.ok(own.body.includes(p.marker));
  assert.equal(own.json().readingMode, "summary-only");
});

test("来源退出editorial在后台republish之前已安全", async () => {
  for (const mode of ["isolated", "hot_signal"]) {
    const p = await pair(mode);
    await updateSource(p.sourceA, { patch: { participation_mode: mode }, version: await sourceVersion(p.sourceA) }, "test");
    const [projection] = await sql`SELECT visibility FROM publications WHERE article_id=${p.a}`;
    assert.equal(projection!.visibility, "public", "验证异步重发尚未执行的窗口");
    await cleanStory(p);
  }
});

test("只撤全文许可或暂停不改变仍公开摘要的事件文字", async () => {
  const p = await pair("licence-control");
  const [before] = await sql`SELECT title,digest,summary,latest,version FROM stories WHERE id=${p.id}`;
  for (const patch of [{ site_fulltext: false }, { enabled: false }]) {
    await updateSource(p.sourceA, { patch, version: await sourceVersion(p.sourceA) }, "test");
  }
  assert.deepEqual({ ...(await sql`SELECT title,digest,summary,latest,version FROM stories WHERE id=${p.id}`)[0] }, { ...before });
  assert.equal((await get(`/api/site/items/${p.a}`)).statusCode, 200);
});

test("更正清除旧事件主张；非eligible历史报道仍可维持事件页面", async () => {
  const corrected = await pair("correction");
  await overrideFields(corrected.a, { fields: { title: "已更正的安全标题", summary: "已更正的安全摘要" }, reason: "测试更正", version: 0 }, "test");
  await cleanStory(corrected);
  const historical = await pair("historical", { eligibleB: false });
  await withdraw(historical.a);
  await cleanStory(historical);
  await withdraw(historical.b);
  assert.equal((await get(`/api/site/stories/${historical.publicId}`)).statusCode, 404);
});

test("重复和版本冲突不重新失效；队列写失败不能提交不安全撤回", async () => {
  const p = await pair("atomic");
  // 只拒绝此事件的重建任务，保留事务原子性断言而不启动worker。
  const constraint = "story_withdrawal_queue_failure";
  await sql`ALTER TABLE pgboss.job ADD CONSTRAINT ${sql(constraint)} CHECK (name <> 'events.digest' OR data->>'storyId' <> ${sql.unsafe("'" + p.id + "'")}) NOT VALID`;
  try {
    await assert.rejects(withdraw(p.a));
    const [state] = await sql`SELECT visibility FROM publications WHERE article_id=${p.a}`;
    assert.equal(state!.visibility, "public", "投影和事件失效应一起回滚");
  } finally { await sql`ALTER TABLE pgboss.job DROP CONSTRAINT ${sql(constraint)}`; }
  // 旧接口可能先写override再投影；读取实际版本，不掩盖不成功的第一次操作。
  const [override] = await sql`SELECT version FROM editorial_overrides WHERE article_id=${p.a}`;
  await withdraw(p.a, "withdrawn", override?.version ?? 0);
  await cleanStory(p);
  const [before] = await sql`SELECT version FROM stories WHERE id=${p.id}`;
  const [current] = await sql`SELECT version FROM editorial_overrides WHERE article_id=${p.a}`;
  await withdraw(p.a, "withdrawn", current!.version);
  await assert.rejects(withdraw(p.a, "withdrawn", current!.version));
  assert.equal((await sql`SELECT version FROM stories WHERE id=${p.id}`)[0]!.version, before!.version);
});


test("同一事件两篇并发撤回不会死锁，也保留第三篇合法报道", async () => {
  const p = await pair("concurrent-removal");
  const c = await article(await source(), "第三篇仍然合法的报道");
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${p.factId},${c},'report')`;
  await Promise.all([withdraw(p.a), withdraw(p.b)]);
  const response = await get(`/api/site/stories/${p.publicId}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().reportCount, 1);
  assert.ok(!response.body.includes(p.marker));
  assert.ok(response.body.includes(c));
});


test("兼容迁移修复升级前的旧坏状态，首次公开读取无需再次触发编辑", async () => {
  const cases = [];
  for (const kind of ["withdrawn", "summary-only", "isolated", "audit-detached"]) {
    const p = await pair(`upgrade-${kind}`, { origin: "replay" });
    // 模拟旧版本已提交的状态，故意不调用新版发布或来源变更入口。
    if (kind === "isolated") await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${p.sourceA}`;
    else await sql`UPDATE publications SET visibility=${kind === "audit-detached" ? "withdrawn" : kind} WHERE article_id=${p.a}`;
    if (kind === "audit-detached") {
      await sql`DELETE FROM fact_articles WHERE article_id=${p.a}`;
      await sql`INSERT INTO audit_log(actor,action,subject,reason,before)
        VALUES('test','content.detach',${`content:${p.a}`},'旧版本移走成员',${sql.json({ facts: [p.factId], stories: [p.id] })})`;
    }
    cases.push(p);
  }
  const control = await pair("upgrade-control");
  const [before] = await sql`SELECT title,digest,version FROM stories WHERE id=${control.id}`;
  const migration = await readFile(new URL("../database/migrations/0040_oss_domain_recovery.sql", import.meta.url), "utf8");
  await sql.begin(tx => tx.unsafe(migration));
  for (const p of cases) {
    await cleanStory(p);
    const [saved] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject=${`story:${p.id}`} AND before::text LIKE ${'%' + p.marker + '%'}`;
    assert.ok(saved!.n > 0);
  }
  assert.deepEqual({ ...(await sql`SELECT title,digest,version FROM stories WHERE id=${control.id}`)[0] }, { ...before });
});


for (const mode of ["isolated", "hot_signal"]) {
  test(`来源变为${mode}后事件扩展读取立即排除旧投影`, async () => {
    const p = await pair(`expansion-${mode}`);
    await updateSource(p.sourceA, { patch: { participation_mode: mode }, version: await sourceVersion(p.sourceA) }, "test");
    assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${p.a}`)[0]!.visibility, "public");
    assert.equal((await get(`/api/site/items/${p.a}`)).statusCode, 404);
    await cleanStory(p);
    for (const path of [`/api/site/groups/${p.factPublicId}/reports`, `/api/site/stories/${p.publicId}/developments`, `/api/site/stories/${p.publicId}/followups`]) {
      const response = await get(path);
      assert.equal(response.statusCode, 200, path);
      assert.ok(!response.body.includes(p.marker), path);
      assert.ok(response.body.includes(p.b), "剩余合法代表稿仍可读");
    }
  });
}

test("无历史综述的人工事件先移走成员再撤回也不会遗失失效范围", async () => {
  const p = await pair("legacy-detach", { origin: "manual" });
  assert.equal((await sql`SELECT 1 FROM story_digests WHERE story_id=${p.id}`).length, 0);
  await detachFromFact(p.a, "测试移走", "test");
  await cleanStory(p);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${p.a}`).length, 0);
  await withdraw(p.a);
  await cleanStory(p);
  assert.equal((await get(`/api/site/items/${p.a}`)).statusCode, 404);
});

test("历史稿自动重置归组后撤回不保留无历史事件副本", async () => {
  const p = await pair("legacy-reset", { origin: "replay" });
  assert.equal((await sql`SELECT 1 FROM story_digests WHERE story_id=${p.id}`).length, 0);
  // 真实历史稿分支在清理旧归属后直接退出，整个用例不需要模型调用。
  await sql`UPDATE articles SET backfill=true,published_at=now()-interval '3 days' WHERE id=${p.a}`;
  assert.equal((await groupArticle(p.a, { force: true })).verdict, "historical");
  await cleanStory(p);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${p.a}`).length, 0);
  await withdraw(p.a);
  await cleanStory(p);
});
