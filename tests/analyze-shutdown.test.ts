// Exercise the real queue callback and process shutdown: already sent model answers must settle
// before the DB closes, and the next process must recover using those receipts.
import { gate, pointModels, Reply, stub, tag } from "./setup.ts";
import { analysisStep, SELECTING_SCORE, type AnalysisStep } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";

const T = tag();
const SOURCE = `test-analyze-stop-${T}`;
let active: {
  calls: AnalysisStep[];
  scoreAsked: ReturnType<typeof gate<void>>;
  structureAsked: ReturnType<typeof gate<void>>;
  scoreAnswer: ReturnType<typeof gate<void>>;
  structureAnswer: ReturnType<typeof gate<void>>;
  writingAsked?: ReturnType<typeof gate<void>>;
  writingAnswer?: ReturnType<typeof gate<void>>;
  failScore: boolean;
};
const provider = await stub(async (_hit, request) => {
  const step = analysisStep(request.body);
  active.calls.push(step);
  const count = active.calls.filter(s => s === step).length;
  if (step === "score" && count === 1) {
    active.scoreAsked.open(); await active.scoreAnswer.promise;
    if (active.failScore) return new Reply(503, { error: "temporary score outage" });
  }
  if (step === "structure" && count === 1) { active.structureAsked.open(); await active.structureAnswer.promise; }
  if (step === "understand" && active.writingAnswer) { active.writingAsked!.open(); await active.writingAnswer.promise; }
  const content = step === "prefilter" ? { label: "PASS", reason: "AI model release" }
    : step === "score" ? { attentionScore: SELECTING_SCORE }
      : step === "structure" ? { category: "ai-models", tags: ["模型发布"], subjects: [], fact: { title: "新模型发布" } }
        : { itemType: "model_release", authorRole: "principal", tags: ["模型发布"], editorialJudgment: "模型有明确的能力提升", titleZh: `新模型发布 ${T}`, summaryZh: "模型发布并提供了评测和价格。" };
  return { id: `stub-${active.calls.length}`, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
const children = new Set<ReturnType<typeof spawn>>();

function worker(queue: string) {
  const script = `
    import { getBoss, stopBoss, shutdownSignal, QUEUES } from '@aihot/backend/jobs/queue';
    import { registerContentJobs } from '@aihot/backend/jobs/content';
    import { closeDb } from '@aihot/backend/db';
    QUEUES.analyze = process.env.TEST_ANALYZE_QUEUE;
    let stopping = false;
    process.on('SIGTERM', async () => {
      if (stopping) return;
      stopping = true;
      shutdownSignal.abort();
      process.send({ stopping: true });
      await stopBoss();
      await closeDb();
      process.disconnect();
    });
    await registerContentJobs(await getBoss());
    process.send({ ready: true });
  `;
  const env = { ...process.env, TEST_ANALYZE_QUEUE: queue, MODEL_CALLS_ENABLED: "true", AIHOT_CREDENTIALS_DIR: "/nonexistent-test-credentials" };
  pointModels(provider.url, undefined, env);
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  const ready = gate();
  const stopping = gate();
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
  child.on("message", (message: any) => { if (message.ready) ready.open(); if (message.stopping) stopping.open(); });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => { children.delete(child); code === 0 ? resolve() : reject(new Error(`analysis worker exited ${code}: ${stderr}`)); });
  });
  return { child, ready: ready.promise, stopping: stopping.promise, done };
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 12_000;
  while (!(await check())) { if (Date.now() > deadline) assert.fail(`timeout waiting for ${label}`); await delay(20); }
}

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${SOURCE},'Analysis shutdown','rss','T1','editorial','2100-01-01')`;
});
after(async () => {
  active?.scoreAnswer.open(); active?.structureAnswer.open(); active?.writingAnswer?.open();
  for (const child of children) child.kill("SIGTERM");
  await provider.close(); await stopBoss(); await closeDb();
});

test("SIGTERM during the final paid writing call still commits the complete analysis and publication", async () => {
  active = { calls: [], scoreAsked: gate(), structureAsked: gate(), scoreAnswer: gate(), structureAnswer: gate(), writingAsked: gate(), writingAnswer: gate(), failScore: false };
  active.scoreAnswer.open(); active.structureAnswer.open();
  const queue = `test.analyze-stop-${T}-final`;
  const boss = await getBoss();
  await boss.createQueue(queue, { policy: "short", retryLimit: 4, retryDelay: 1, expireInSeconds: 120 });
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/analyze-stop-${T}/final`, title: `Final model release ${T}`,
    bodyText: `A lab released a new AI model with benchmarks and prices. ${T} ` + "The release explains model capabilities and evaluation results. ".repeat(10),
    bodyStatus: "ok", language: "en", via: "fetch", publishedAt: new Date() });
  const jobId = await boss.send(queue, { articleId }, { singletonKey: articleId });
  const running = worker(queue);
  await Promise.race([Promise.all([running.ready, active.writingAsked!.promise]), running.done.then(() => assert.fail("worker exited before writing"))]);
  running.child.kill("SIGTERM"); await running.stopping;
  active.writingAnswer!.open(); await running.done;
  assert.deepEqual(active.calls.slice().sort(), ["prefilter", "score", "score", "structure", "understand"]);
  assert.equal((await sql`SELECT state FROM pgboss.job WHERE id=${jobId}`)[0]!.state, "completed");
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${articleId}`)[0]!.processing_state, "analyzed");
  const [analysis] = await sql`SELECT selected,score,receipt_ids FROM analyses WHERE article_id=${articleId}`;
  assert.equal(analysis!.selected, true); assert.equal(analysis!.score, SELECTING_SCORE); assert.equal(analysis!.receipt_ids.length, 5);
  assert.deepEqual({ ...(await sql`SELECT selected, selection_candidate FROM publications WHERE article_id=${articleId}`)[0] },
    { selected: false, selection_candidate: true }, "saved analysis nominates a candidate while news identity is pending");
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${`article:${articleId}@1`} AND status='completed'`).length, 5);
});

for (const failScore of [false, true]) test(`SIGTERM during ${failScore ? "failed" : "successful"} first score drains slower structure and leaves a retryable job`, async () => {
  active = { calls: [], scoreAsked: gate(), structureAsked: gate(), scoreAnswer: gate(), structureAnswer: gate(), failScore };
  const queue = `test.analyze-stop-${T}-${failScore}`;
  const boss = await getBoss();
  // Isolate this real pg-boss worker from articles queued by the other invariant tests. No retry delay:
  // the restarted worker's first poll takes the retry instead of waiting out a polling interval.
  await boss.createQueue(queue, { policy: "short", retryLimit: 4, retryDelay: 0, expireInSeconds: 120 });
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/analyze-stop-${T}/${failScore}`, title: `A new model released ${T} ${failScore}`,
    bodyText: `A lab released a new AI model with benchmarks and prices. ${T} ${failScore} ` + "The release explains model capabilities and evaluation results. ".repeat(10),
    bodyStatus: "ok", language: "en", via: "fetch", publishedAt: new Date() });
  await sql`UPDATE articles SET processing_attempts=2,processing_error='prior temporary failure',processing_queued_at=now() WHERE id=${articleId}`;
  const jobId = await boss.send(queue, { articleId }, { singletonKey: articleId });
  const first = worker(queue);
  await Promise.race([Promise.all([first.ready, active.scoreAsked.promise, active.structureAsked.promise]), first.done.then(() => assert.fail("worker exited before both requests"))]);
  first.child.kill("SIGTERM"); await first.stopping;
  active.scoreAnswer.open();
  await until(async () => !!(await sql`SELECT 1 FROM receipts WHERE subject=${`article:${articleId}@1`} AND purpose='score_article' AND status IN ('received','failed')`)[0], "score receipt");
  assert.equal(first.child.exitCode, null, "the process stays alive while structure owns a paid response");
  assert.equal((await sql`SELECT state FROM pgboss.job WHERE id=${jobId}`)[0]!.state, "active");
  assert.deepEqual(active.calls.filter(s => s !== "prefilter").sort(), ["score", "structure"], "no second score or writing starts during shutdown");
  active.structureAnswer.open(); await first.done;
  const [article] = await sql`SELECT processing_state,processing_attempts,processing_error FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...article }, { processing_state: "new", processing_attempts: 2, processing_error: "prior temporary failure" });
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0, "an interrupted chain commits no terminal judgement");
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${articleId}`).length, 0);
  const receipts = await sql`SELECT purpose,status FROM receipts WHERE subject=${`article:${articleId}@1`} ORDER BY purpose`;
  assert.deepEqual(receipts.map(r => [r.purpose,r.status]), [["prefilter_article","received"],["score_article",failScore ? "failed" : "received"],["structure_article","received"]]);
  assert.equal((await sql`SELECT state FROM pgboss.job WHERE id=${jobId}`)[0]!.state, "retry", "pg-boss owns restart recovery");
  const restarted = worker(queue); await restarted.ready;
  await until(async () => (await sql`SELECT state FROM pgboss.job WHERE id=${jobId}`)[0]?.state === "completed", "completed retry");
  restarted.child.kill("SIGTERM"); await restarted.done;
  assert.equal(active.calls.filter(s => s === "prefilter").length, 1);
  assert.equal(active.calls.filter(s => s === "structure").length, 1, "the slow structure answer was saved and reused");
  assert.equal(active.calls.filter(s => s === "score").length, failScore ? 3 : 2, "two ordered successful scores, only a rejected request repeats");
  assert.equal(active.calls.filter(s => s === "understand").length, 1);
  const [result] = await sql`SELECT selected,score,receipt_ids FROM analyses WHERE article_id=${articleId}`;
  assert.equal(result!.selected, true); assert.equal(result!.score, SELECTING_SCORE); assert.equal(result!.receipt_ids.length, 5);
  assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${articleId}`)[0]!.processing_attempts, 0);
});
