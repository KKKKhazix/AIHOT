// Recovery must finish the same evaluation that failed, and commit the release, queue and audit together.
import { gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { rerun } from "@aihot/backend/admin/content";
import { processArticle, queueProcessing, registerContentJobs, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { recoverStaleWork, releaseReceipt } from "@aihot/backend/operations/recover";
import { ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const T = tag();
const SOURCE = `recovery-${T}`;
let original = true;
let refuseScore = true;
const calls: string[] = [];
let heldFailure: { input: string; asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body);
  if (heldFailure && request.body.includes(heldFailure.input)) {
    heldFailure.asked.open();
    await heldFailure.release.promise;
    return new Reply(400, { error: "old revision refused" });
  }
  const system = String(body.messages[0]?.content ?? "");
  const step = system.includes("宽召回") ? "prefilter"
    : system.includes("事件注意力评分器") ? "score"
    : system.includes("资料结构化助手") ? "structure" : "understand";
  calls.push(step);
  if (step === "score" && refuseScore) {
    refuseScore = false;
    return new Reply(503, { error: "temporary outage" });
  }
  const content = step === "prefilter" ? { label: original ? "BLOCK" : "PASS", reason: "local fixture" }
    : step === "score" ? { attentionScore: 80 }
    : step === "structure" ? { category: "ai-models", tags: [], subjects: [], fact: null }
    : { itemType: "model_release", authorRole: "principal", tags: ["模型发布"], editorialJudgment: "模型能力提升", titleZh: `新判断 ${T}`, summaryZh: "模型发布并提供评测和价格。" };
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
});
for (const name of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[name] = `${provider.url}/v1`;
for (const name of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[name] = "test-key";
process.env.PREFILTER_MODEL = "qwen3.7-flash";
process.env.SCORE_MODEL = "glm-5.3-flash-selection";
process.env.STRUCTURE_MODEL = "qwen3.8-flash";
process.env.UNDERSTAND_MODEL = "glm-5.3-flash";

// This file runs real queue workers; park other files' fixtures while the shared test database is in use.
let parkedJobs: Array<{ id: string; start_after: Date }> = [];
let parkedArticles: Array<{ id: string; processing_queued_at: Date | null }> = [];
let savedBudgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  await getBoss();
  parkedJobs = await sql`SELECT id, start_after FROM pgboss.job WHERE state IN ('created', 'retry')`;
  if (parkedJobs.length) await sql`UPDATE pgboss.job SET start_after='2100-01-01' WHERE id = ANY(${parkedJobs.map((j) => j.id)}::uuid[])`;
  parkedArticles = await sql`SELECT id, processing_queued_at FROM articles WHERE processing_state='new'`;
  if (parkedArticles.length) await sql`UPDATE articles SET processing_queued_at='2100-01-01' WHERE id = ANY(${parkedArticles.map((a) => a.id)}::text[])`;
  savedBudgets = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service IN ('dashscope', 'zhipu', 'deepseek')`;
  await sql`UPDATE budgets SET per_minute=10000,per_hour=10000,per_day=100000 WHERE service IN ('dashscope', 'zhipu', 'deepseek')`;

  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${SOURCE},'Recovery','rss','T1','editorial','2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await provider.close();
  if (parkedJobs.length) await sql`UPDATE pgboss.job j SET start_after = old.start_after
    FROM jsonb_to_recordset(${sql.json(parkedJobs as never)}) AS old(id uuid, start_after timestamptz) WHERE j.id=old.id`;
  if (parkedArticles.length) await sql`UPDATE articles a SET processing_queued_at = old.processing_queued_at
    FROM jsonb_to_recordset(${sql.json(parkedArticles as never)}) AS old(id text, processing_queued_at timestamptz) WHERE a.id=old.id`;
  for (const b of savedBudgets) await sql`UPDATE budgets SET per_minute=${b.per_minute}, per_hour=${b.per_hour}, per_day=${b.per_day} WHERE service=${b.service}`;
  await closeDb();
});
afterEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id=${SOURCE})`;
});

async function article(name: string) {
  return (await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${T}/${name}`, title: `AI model ${T} ${name}`,
    bodyText: `AI lab release ${T} ${name}. ` + "The new model includes benchmark and price details. ".repeat(12),
    bodyStatus: "ok", via: "fetch", backfill: "test fixture", publishedAt: new Date() })).articleId;
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "queue did not settle");
    await delay(20);
  }
}

test("a failed audit rolls back the receipt release and the processing job", async () => {
  const id = await article("atomic");
  await sql`UPDATE articles SET processing_state='failed',processing_error='unknown receipt' WHERE id=${id}`;
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key,service,purpose,subject,status)
    VALUES (${`atomic-${T}`},'deepseek','score_article',${`article:${id}@1`},'unknown') RETURNING id`;
  await sql.unsafe(`CREATE FUNCTION fail_release_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'test-release-atomic' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER fail_release_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_release_audit()");
  try {
    await assert.rejects(releaseReceipt(receipt!.id, { billed: false, note: "verified" }, "test-release-atomic"), /injected audit failure/);
  } finally {
    await sql.unsafe("DROP TRIGGER fail_release_audit ON audit_log");
    await sql.unsafe("DROP FUNCTION fail_release_audit()");
  }
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`)[0]!.status, "unknown");
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state, "failed");
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE data->>'articleId'=${id}`).length, 0);
  const released = await releaseReceipt(receipt!.id, { billed: false, note: "verified" }, "test");
  assert.equal(released?.requeued, true);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`receipt:${receipt!.id}`} AND action='receipt.release'`).length, 1);
  const boss = await getBoss();
  const jobs = await boss.fetch(QUEUES.analyze);
  for (const job of jobs) await boss.complete(QUEUES.analyze, job.id);
});

test("a manual re-evaluation survives extraction, a lost job, and receipt release with the same paid identity", async () => {
  const id = await article("identity");
  const attemptTag = `admin:${T}`;
  const boss = await getBoss();
  await queueProcessing(id, { attemptTag });
  const [job] = await boss.fetch(QUEUES.analyze);
  assert.ok(job);
  await boss.complete(QUEUES.analyze, job.id);
  // The extraction job carries only articleId; its handoff must retain the evaluation identity.
  await queueProcessing(id, { step: "analyze" });
  const [afterBody] = await boss.fetch(QUEUES.analyze);
  assert.deepEqual(afterBody!.data, { articleId: id, attemptTag });
  await boss.complete(QUEUES.analyze, afterBody!.id);
  await sql`UPDATE articles SET processing_state='failed' WHERE id=${id}`;
  const [r] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key,service,purpose,subject,status)
    VALUES (${`identity-${T}`},'deepseek','score_article',${`article:${id}@1`},'unknown') RETURNING id`;
  await releaseReceipt(r!.id, { billed: false, note: "verified" }, "test");
  const [afterRelease] = await boss.fetch(QUEUES.analyze);
  assert.deepEqual(afterRelease!.data, { articleId: id, attemptTag });
  await boss.complete(QUEUES.analyze, afterRelease!.id);
});

test("an already released receipt wakes its failed grouping job once, with the original parameters", async () => {
  const id = await article("grouping");
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key,service,purpose,subject,status)
    VALUES (${`embedding-${T}`},'dashscope','embedding',${`article:${id}`},'unknown') RETURNING id`;
  const data = { articleId: id, signalOnly: true, force: true };
  const jobId = await enqueue(QUEUES.group, data, { retryLimit: 0, singletonKey: id });
  const boss = await getBoss();
  const [initial] = await boss.fetch(QUEUES.group);
  assert.equal(initial!.id, jobId);
  await boss.fail(QUEUES.group, jobId!, new ReceiptUnknownError(receipt!.id, "receipt outcome unknown"));
  await releaseReceipt(receipt!.id, { billed: false, note: "verified" }, "test");
  // This also covers a process stopping just after the release, before waking the queue.
  await recoverStaleWork();
  const [resumed] = await boss.fetch(QUEUES.group);
  assert.equal(resumed?.id, jobId);
  assert.deepEqual(resumed!.data, data);
  await boss.fail(QUEUES.group, jobId!, new ReceiptUnknownError(receipt!.id, "failed again after release"));
  await recoverStaleWork();
  assert.equal((await boss.getJobById(QUEUES.group, jobId!))!.state, "failed", "the old release cannot create an endless retry loop");
});

test("a temporary provider failure resumes the manual evaluation instead of reinstalling the old verdict", async () => {
  const id = await article("retry");
  assert.equal((await processArticle(id)).state, "block");
  original = false;
  await registerContentJobs(await getBoss(), 1);
  const result = await rerun(id, "analyze", `retry-${T}`, "test");
  await waitFor(async () => (await sql`SELECT state FROM pgboss.job WHERE id=${result!.jobId}`)[0]?.state === "completed");
  assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${id}`)[0]!.processing_attempts, 1);
  await sql`UPDATE articles SET processing_retry_at=now()-interval '1 minute',created_at=now()-interval '10 minutes' WHERE id=${id}`;
  await sweepUnprocessed();
  await waitFor(async () => (await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${id} AND state<'completed'`).length === 0);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state, "analyzed");
  assert.equal((await sql`SELECT selected FROM publications WHERE article_id=${id}`)[0]!.selected, true);
  assert.equal(calls.filter((s) => s === "prefilter").length, 2, "one original and one manual prefilter; recovery buys neither again");
  assert.equal(calls.filter((s) => s === "structure").length, 1, "the paid structure response survives the score failure");
});

// Failure modes: an old paid call can fail after a new material revision has already finished;
// its refusal must neither replace that verdict nor restore retries or clear the new queue state.
test("a late refusal for an old revision preserves the new revision's completed processing", async () => {
  const id = await article("revision-race");
  const asked = gate();
  const release = gate();
  heldFailure = { input: `revision-race`, asked, release };
  const jobId = await queueProcessing(id);
  await asked.promise;
  try {
    await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${T}/revision-race`, title: `Corrected ${T}`,
      bodyText: "A different corrected article body. ".repeat(30), bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    heldFailure = null;
    original = true;
    assert.equal((await processArticle(id)).state, "block");
  } finally {
    heldFailure = null;
    release.open();
  }
  await waitFor(async () => (await sql`SELECT state FROM pgboss.job WHERE id=${jobId}`)[0]?.state === "completed");
  const [current] = await sql`SELECT processing_state, processing_attempts, processing_error, processing_retry_at FROM articles WHERE id=${id}`;
  assert.equal(current!.processing_state, "blocked");
  assert.equal(current!.processing_attempts, 0);
  assert.equal(current!.processing_error, null);
  assert.equal(current!.processing_retry_at, null);
});
