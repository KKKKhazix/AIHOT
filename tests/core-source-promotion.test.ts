// 信源转为编辑来源后，补齐尚未分析的资料；沿用正文、历史归档和人工覆盖规则。
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { sourceDetail, updateSource } from "@aihot/backend/admin/sources";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { ingestItems } from "@aihot/backend/ingest/items";
import { processArticle, queueProcessing, settleNonEditorial, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { republishSource } from "@aihot/backend/publication/publish";

const T = tag();
const BODY = `A lab released a new AI model with benchmark results and pricing details. ${T} `.repeat(12);
const originalConfig = { modelCallsEnabled: config.modelCallsEnabled, allowPrivateNetworkFetch: config.allowPrivateNetworkFetch };
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  const system = body.messages[0]?.role === "system" ? body.messages[0].content : "";
  const input = JSON.stringify(body.messages);
  let answer: unknown;
  if (system.includes("宽召回")) answer = { label: input.includes("OFFTOPIC") ? "BLOCK" : "PASS", reason: "测试" };
  else if (system.includes("事件注意力评分器")) answer = { attentionScore: 80 };
  else if (system.includes("内容理解编辑")) answer = { itemType: "model_release", authorRole: "principal", tags: ["模型发布"], editorialJudgment: "测试判断", titleZh: "某实验室发布新模型", summaryZh: "某实验室发布新模型，并公布评测结果和价格。" };
  else if (system.includes("资料结构化助手")) answer = { category: "ai-models", tags: ["模型发布"], subjects: [], fact: { title: "某实验室发布新模型" } };
  else throw new Error("unexpected model request");
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
for (const name of ["DASHSCOPE", "ZHIPU", "DEEPSEEK", "LLM"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "test-key";
}
let pageHits = 0;
const page = http.createServer((_req, res) => {
  pageHits += 1;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Model release</title></head><body><article><h1>Model release</h1><p>${BODY}</p></article></body></html>`);
});
await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
config.modelCallsEnabled = true;
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service IN ('dashscope', 'zhipu', 'deepseek', 'llm')`;
});
after(async () => {
  Object.assign(config, originalConfig);
  await provider.close();
  await new Promise<void>((resolve) => page.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

async function edit(sourceId: string, patch: Record<string, unknown>) {
  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${sourceId}`;
  return updateSource(sourceId, { patch, version: source!.updated_at.toISOString() }, "test");
}

async function processingJobs(articleId: string) {
  return sql<{ name: string; priority: number; data: { articleId: string; attemptTag?: string }; state: string }[]>`
    SELECT name, priority, data, state FROM pgboss.job
    WHERE data->>'articleId' = ${articleId} AND name IN (${QUEUES.extractBody}, ${QUEUES.analyze})
    ORDER BY created_on, id`;
}

async function source(suffix: string, mode = "isolated") {
  const id = `test-promote-${T}-${suffix}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${id}, 'Test promotion', 'external', 'T2', ${mode}, '2100-01-01')`;
  return id;
}

async function material(sourceId: string, suffix: string, extra: Record<string, unknown> = {}) {
  return (await upsertMaterial({
    sourceId, url: `${pageUrl}/${T}-${suffix}`, title: `Model release ${T} ${suffix}`, bodyText: BODY, bodyStatus: "ok",
    via: "fetch", publishedAt: new Date(), ...extra,
  } as Parameters<typeof upsertMaterial>[0])).articleId;
}

// In the open-source edition original-source identity is configurable independently of tier.
test("source details preserve the configured first-party identity at every tier", async () => {
  for (const [tier, firstParty] of [["T1", false], ["T2", true]] as const) {
    const id = await source(`identity-${tier}`);
    await sql`UPDATE sources SET tier = ${tier}, first_party = ${firstParty} WHERE id = ${id}`;
    assert.equal((await sourceDetail(id))?.source.first_party, firstParty);
  }
});

test("promoting a settled auto-created source resumes normal editorial extraction", async () => {
  const sourceId = `test-promote-${T}-ingest`;
  assert.deepEqual(await ingestItems({ sourceId, items: [{ title: `Model release ${T}`, url: `${pageUrl}/${T}-ingest`, publishedAt: new Date().toISOString() }] }), { ok: true, created: 1 });
  const [article] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${sourceId}`;
  const id = article!.id;
  await settleNonEditorial(id);
  await sql`UPDATE articles SET created_at = now() - interval '5 minutes' WHERE id = ${id}`;
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${id}`)[0]!.processing_state, "skipped");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0);

  await edit(sourceId, { participation_mode: "editorial" });
  await republishSource(sourceId);
  await sweepUnprocessed();
  const jobs = await processingJobs(id);
  assert.equal(jobs[0]?.name, QUEUES.extractBody, "promotion must resume normal editorial processing after isolated ingestion");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.priority, 0);
  assert.equal(jobs[0]!.data.attemptTag, undefined);
  assert.equal(provider.hits(), 0, "promotion and republish must not call models");

});

test("resumed extraction and analysis publish the fetched body at its current revision", async () => {
  const sourceId = await source("extract");
  // 外部推送会规范化为 HTTPS；正文链路单独使用真实 HTTP 回环夹具。
  const id = await material(sourceId, "extract", { bodyText: null, bodyStatus: "pending" });
  await settleNonEditorial(id);
  await edit(sourceId, { participation_mode: "editorial" });
  assert.equal((await processingJobs(id))[0]?.name, QUEUES.extractBody);
  assert.equal(await extractArticleBody(id, false), "ok");
  assert.equal(pageHits, 1);
  await queueProcessing(id);
  assert.equal((await processingJobs(id)).at(-1)?.name, QUEUES.analyze);
  assert.deepEqual(await processArticle(id), { state: "pass" });
  const analyses = await sql`SELECT a.input_revision, r.revision FROM analyses a JOIN articles r ON r.id = a.article_id WHERE a.article_id = ${id}`;
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0]!.input_revision, analyses[0]!.revision);
  assert.equal(analyses[0]!.revision, 2, "fetched body is assessed at its new revision");
  const [publication] = await sql`SELECT eligible, visibility, title, summary FROM publications WHERE article_id = ${id}`;
  assert.equal(publication!.eligible, true);
  assert.equal(publication!.visibility, "public");
  assert.match(String(publication!.title), /实验室/);
  assert.match(String(publication!.summary), /评测/);
  assert.ok(provider.hits() >= 5, "normal budgeted model stages used the local fixture");
});

test("hot-signal promotion analyzes a ready body without fetching and retains relevance filtering", async () => {
  const sourceId = await source("signal", "hot_signal");
  const id = await material(sourceId, "signal");
  const blocked = await material(sourceId, "OFFTOPIC", { title: `OFFTOPIC ${T}` });
  await settleNonEditorial(id);
  await settleNonEditorial(blocked);
  const hits = pageHits;
  await edit(sourceId, { participation_mode: "editorial" });
  for (const articleId of [id, blocked]) {
    const jobs = await processingJobs(articleId);
    assert.equal(jobs.length, 1);
    assert.deepEqual([jobs[0]!.name, jobs[0]!.priority, jobs[0]!.data.attemptTag], [QUEUES.analyze, 0, undefined]);
  }
  assert.deepEqual(await processArticle(id), { state: "pass" });
  assert.deepEqual(await processArticle(blocked), { state: "block" });
  assert.equal(pageHits, hits, "confirmed bodies are not fetched again");
  const [publication] = await sql`SELECT eligible, selected FROM publications WHERE article_id = ${blocked}`;
  assert.deepEqual([publication!.eligible, publication!.selected], [false, false]);
});

test("promotion preserves history, material identity and manual editorial/grouping overrides", async () => {
  const sourceId = await source("history");
  const old = await material(sourceId, "history", { publishedAt: new Date(Date.now() - 30 * 86_400_000), backfill: "reported-backfill" });
  const live = await material(sourceId, "live");
  await settleNonEditorial(old);
  await settleNonEditorial(live);
  const timeline = async () => sql`
    SELECT id, identity_key, source_id, revision, content_hash, published_at, discovered_at, timeline_at, backfill, backfill_reason
    FROM articles WHERE id IN (${old}, ${live}) ORDER BY id`;
  const beforeTimeline = await timeline();
  await sql`INSERT INTO editorial_overrides (article_id, fields, visibility, reason, updated_by)
            VALUES (${old}, ${sql.json({ title: "人工标题", summary: "人工摘要", selected: false })}, 'withdrawn', 'test', 'test')`;
  await sql`INSERT INTO grouping_overrides (article_id, reason, actor) VALUES (${old}, 'test', 'test')`;
  const overrides = async () => ({
    editorial: [...await sql`SELECT * FROM editorial_overrides WHERE article_id = ${old}`],
    grouping: [...await sql`SELECT * FROM grouping_overrides WHERE article_id = ${old}`],
  });
  const beforeOverrides = await overrides();
  await edit(sourceId, { participation_mode: "editorial" });
  assert.deepEqual([...(await timeline())], [...beforeTimeline]);
  assert.deepEqual([(await processingJobs(old))[0]?.priority, (await processingJobs(live))[0]?.priority], [-2, 0]);
  assert.deepEqual(await processArticle(old), { state: "pass" });
  await republishSource(sourceId);
  assert.deepEqual([...(await timeline())], [...beforeTimeline]);
  assert.deepEqual(await overrides(), beforeOverrides);
  const [publication] = await sql`SELECT title, summary, selected, visibility FROM publications WHERE article_id = ${old}`;
  assert.deepEqual([publication!.title, publication!.summary, publication!.selected, publication!.visibility], ["人工标题", "人工摘要", false, "withdrawn"]);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${old}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.group} AND data->>'articleId' = ${old}`).length, 0, "history adds no event or heat work");
});

test("only skipped articles without a current-revision analysis resume", async () => {
  const sourceId = await source("revision");
  const current = await material(sourceId, "current");
  const stale = await material(sourceId, "stale");
  for (const id of [current, stale]) {
    await settleNonEditorial(id);
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected)
              VALUES (${id}, 1, 'rule', 'pass', '原有中文标题', '原有中文摘要', false)`;
  }
  await sql`UPDATE articles SET revision = 2 WHERE id = ${stale}`;
  const untouched: Array<{ id: string; state: string }> = [];
  for (const state of ["new", "failed", "blocked", "analyzed"]) {
    const id = await material(sourceId, `state-${state}`);
    await sql`UPDATE articles SET processing_state = ${state} WHERE id = ${id}`;
    untouched.push({ id, state });
  }
  const prior = [...await sql`SELECT * FROM analyses WHERE article_id IN (${current}, ${stale}) ORDER BY id`];
  const hits = provider.hits();
  await edit(sourceId, { participation_mode: "editorial" });
  await republishSource(sourceId);
  assert.equal((await processingJobs(current)).length, 0, "a current assessment is only reprojected");
  assert.equal((await processingJobs(stale)).length, 1, "an older assessment cannot stand in for the current revision");
  assert.equal((await sql`SELECT eligible FROM publications WHERE article_id = ${current}`)[0]!.eligible, true);
  assert.equal(provider.hits(), hits);
  assert.deepEqual([...await sql`SELECT * FROM analyses WHERE article_id IN (${current}, ${stale}) ORDER BY id`], prior);
  for (const { id, state } of untouched) {
    assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${id}`)[0]!.processing_state, state);
    assert.equal((await processingJobs(id)).length, 0);
  }
  assert.deepEqual(await processArticle(stale), { state: "pass" });
  assert.deepEqual((await sql`SELECT input_revision FROM analyses WHERE article_id = ${stale} ORDER BY input_revision`).map((a) => a.input_revision), [1, 2]);
});

test("unrelated, no-op and reverse changes do not restart work; promotion remains idempotent", async () => {
  const sourceId = await source("edits");
  const id = await material(sourceId, "edits");
  await settleNonEditorial(id);
  await edit(sourceId, { name: "Renamed source", tier: "T1", site_fulltext: true });
  await republishSource(sourceId);
  assert.equal((await processingJobs(id)).length, 0);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${id}`)[0]!.processing_state, "skipped");
  await edit(sourceId, { participation_mode: "editorial" });
  const firstJobs = await processingJobs(id);
  const [before] = await sql`SELECT processing_queued_at FROM articles WHERE id = ${id}`;
  await edit(sourceId, { participation_mode: "editorial" });
  await edit(sourceId, {});
  await republishSource(sourceId);
  assert.deepEqual([...(await processingJobs(id))], [...firstJobs]);
  assert.equal((await sql`SELECT processing_queued_at FROM articles WHERE id = ${id}`)[0]!.processing_queued_at.getTime(), before!.processing_queued_at.getTime());
  assert.equal(firstJobs.length, 1);
  assert.equal(firstJobs[0]!.data.attemptTag, undefined);

  const editorial = await source("already-editorial", "editorial");
  const untouched = await material(editorial, "already-editorial");
  await sql`UPDATE articles SET processing_state = 'skipped' WHERE id = ${untouched}`;
  await edit(editorial, { participation_mode: "editorial" });
  await edit(editorial, { participation_mode: "hot_signal" });
  await edit(editorial, { participation_mode: "isolated" });
  assert.equal((await processingJobs(untouched)).length, 0);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${untouched}`)[0]!.processing_state, "skipped");
});

test("promotion retains paused state and a late non-editorial completion cannot skip resumed work", async () => {
  const sourceId = await source("paused", "hot_signal");
  const id = await material(sourceId, "paused");
  await queueProcessing(id);
  await settleNonEditorial(id);
  await edit(sourceId, { enabled: false });
  await edit(sourceId, { participation_mode: "editorial" });
  assert.deepEqual(await settleNonEditorial(id), { group: false });
  const [article] = await sql`SELECT processing_state FROM articles WHERE id = ${id}`;
  const [saved] = await sql`SELECT enabled, health FROM sources WHERE id = ${sourceId}`;
  assert.equal(article!.processing_state, "new");
  assert.deepEqual([saved!.enabled, saved!.health], [false, "paused"]);
  assert.equal((await processingJobs(id)).length, 1);
});

test("large promotion resets every eligible item, queues the newest 500, and sweep recovers the rest", async () => {
  const sourceId = await source("bulk");
  const ids: string[] = [];
  const now = Date.now();
  for (let i = 0; i < 502; i += 1) {
    ids.push(await material(sourceId, `bulk-${i}`, { discoveredAt: new Date(now - i * 1000) }));
  }
  await sql`UPDATE articles SET processing_state = 'skipped', processing_attempts = 4, processing_error = 'stale error',
            processing_retry_at = now() + interval '1 day', processing_queued_at = now(), created_at = now() - interval '5 minutes'
            WHERE source_id = ${sourceId}`;
  await edit(sourceId, { participation_mode: "editorial" });
  const [state] = await sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE processing_state = 'new' AND processing_attempts = 0 AND processing_error IS NULL AND processing_retry_at IS NULL)::int AS reset,
      count(*) FILTER (WHERE processing_queued_at IS NOT NULL)::int AS queued
    FROM articles WHERE source_id = ${sourceId}`;
  assert.deepEqual([state!.total, state!.reset, state!.queued], [502, 502, 500]);
  const queuedIds = async () => (await sql<{ article_id: string }[]>`
    SELECT j.data->>'articleId' AS article_id FROM pgboss.job j JOIN articles a ON a.id = j.data->>'articleId'
    WHERE a.source_id = ${sourceId} AND j.name = ${QUEUES.analyze}`).map((r) => r.article_id).sort();
  assert.deepEqual(await queuedIds(), ids.slice(0, 500).sort());
  for (const id of ids.slice(500)) assert.equal((await processingJobs(id)).length, 0);
  assert.equal((await sweepUnprocessed()).enqueued, 2);
  assert.deepEqual(await queuedIds(), [...ids].sort());
  assert.equal((await sweepUnprocessed()).enqueued, 0);
  await edit(sourceId, { participation_mode: "editorial" });
  assert.equal((await queuedIds()).length, 502);
});

test("failure after processing job insertion rolls back source, article reset and queued jobs together", async () => {
  const sourceId = await source("rollback");
  const id = await material(sourceId, "rollback");
  await settleNonEditorial(id);
  await sql`UPDATE articles SET processing_attempts = 3, processing_error = 'preserve on rollback', processing_retry_at = now() + interval '1 day' WHERE id = ${id}`;
  const [beforeSource] = await sql`SELECT * FROM sources WHERE id = ${sourceId}`;
  const [beforeArticle] = await sql`SELECT * FROM articles WHERE id = ${id}`;
  // 在重新发布标记写入时故意失败，并确认此前已走过文章重置及任务插入。
  await sql.unsafe(`CREATE FUNCTION test_promotion_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.key = 'republish.source:${sourceId}' THEN
        IF NOT EXISTS (SELECT 1 FROM pgboss.job WHERE data->>'articleId' = '${id}' AND name = 'content.analyze') THEN
          RAISE EXCEPTION 'processing job missing before rollback';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM articles WHERE id = '${id}' AND processing_state = 'new') THEN
          RAISE EXCEPTION 'article reset missing before rollback';
        END IF;
        RAISE EXCEPTION 'intentional promotion rollback';
      END IF;
      RETURN NEW;
    END $$`);
  await sql.unsafe(`CREATE TRIGGER test_promotion_rollback BEFORE INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION test_promotion_rollback()`);
  try {
    await assert.rejects(edit(sourceId, { participation_mode: "editorial" }), /intentional promotion rollback/);
  } finally {
    await sql.unsafe(`DROP TRIGGER test_promotion_rollback ON settings`);
    await sql.unsafe(`DROP FUNCTION test_promotion_rollback()`);
  }
  assert.deepEqual((await sql`SELECT * FROM sources WHERE id = ${sourceId}`)[0], beforeSource);
  assert.deepEqual((await sql`SELECT * FROM articles WHERE id = ${id}`)[0], beforeArticle);
  assert.equal((await processingJobs(id)).length, 0);
  assert.equal((await sql`SELECT 1 FROM settings WHERE key = ${`republish.source:${sourceId}`}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.republishSource} AND data->>'sourceId' = ${sourceId}`).length, 0);
});


test("overlapping promotion and old settlement leave the unscheduled tail recoverable", async () => {
  const sourceId = await source("overlap", "hot_signal");
  const ids: string[] = [];
  const now = Date.now();
  for (let i = 0; i < 502; i += 1) {
    ids.push(await material(sourceId, `overlap-${i}`, { discoveredAt: new Date(now - i * 1000) }));
  }
  await sql`UPDATE articles SET processing_state = 'skipped', created_at = now() - interval '5 minutes' WHERE source_id = ${sourceId}`;
  const target = ids[501]!;
  const lockKey = 6120501;
  const hold = await sql.reserve();
  const [holder] = await hold<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  let promotion: ReturnType<typeof edit> | undefined;
  let settlement: ReturnType<typeof settleNonEditorial> | undefined;
  let triggerCreated = false;
  async function waitForBlocked(blocker: number) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [waiting] = await sql<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`;
      if (waiting) return waiting.pid;
      await delay(10);
    }
    throw new Error(`No transaction blocked by backend ${blocker}`);
  }
  try {
    await hold`SELECT pg_advisory_lock(${lockKey})`;
    // 在重置和首批任务均已写入、尚未提交时暂停真实晋升事务。
    await sql.unsafe(`CREATE FUNCTION test_promotion_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.key = 'republish.source:${sourceId}' THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF;
        RETURN NEW;
      END $$`);
    await sql.unsafe(`CREATE TRIGGER test_promotion_gate BEFORE INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION test_promotion_gate()`);
    triggerCreated = true;
    promotion = edit(sourceId, { participation_mode: "editorial" });
    const promotionPid = await waitForBlocked(holder!.pid);
    settlement = settleNonEditorial(target);
    await waitForBlocked(promotionPid);
    await hold`SELECT pg_advisory_unlock(${lockKey})`;
    await promotion;
    const settled = await settlement;
    const [state] = await sql`
      SELECT a.processing_state, a.processing_queued_at, s.participation_mode
      FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${target}`;
    assert.equal((await processingJobs(target)).length, 0, "the tail has no immediate job to mask a lost reset");
    await sweepUnprocessed();
    assert.equal(state!.participation_mode, "editorial");
    assert.equal(state!.processing_state, "new", "an old overlapping settlement must not re-skip promoted material");
    assert.deepEqual(settled, { group: false });
    assert.equal((await processingJobs(target)).length, 1, "the sweep must recover the unscheduled promoted item");
  } finally {
    await hold`SELECT pg_advisory_unlock(${lockKey})`;
    hold.release();
    if (promotion) await promotion.catch(() => {});
    if (settlement) await settlement.catch(() => {});
    if (triggerCreated) await sql.unsafe(`DROP TRIGGER test_promotion_gate ON settings`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS test_promotion_gate()`);
  }
});
