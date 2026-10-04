// A hard-killed analysis must distinguish a lost paid answer from one already saved.
// These are real processes and PostgreSQL transactions with a local model protocol substitute;
// they do not test provider quality, machine power loss, or a browser journey.
import { gate, pointModels, stub, tag } from "./setup.ts";
import { analysisStep, SELECTING_SCORE, type AnalysisStep } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { markStalePendingReceipts } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";

const T = tag();
const SOURCE = `test-analyze-kill-${T}`;
let calls: AnalysisStep[] = [];
let holdPrefilter: { asked: ReturnType<typeof gate<void>>; answer: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async (_hit, request) => {
  const step = analysisStep(request.body);
  calls.push(step);
  if (step === "prefilter" && holdPrefilter) {
    const held = holdPrefilter;
    held.asked.open();
    await held.answer.promise;
  }
  const content = step === "prefilter" ? { label: "PASS", reason: "AI model release" }
    : step === "score" ? { attentionScore: SELECTING_SCORE }
      : step === "structure" ? { category: "ai-models", tags: ["模型发布"], subjects: [], fact: { title: "新模型发布" } }
        : { itemType: "model_release", authorRole: "principal", tags: ["模型发布"], editorialJudgment: "模型有明确的能力提升", titleZh: `新模型发布 ${T}`, summaryZh: "模型发布并提供了评测和价格。" };
  return { id: `stub-${calls.length}`, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});

type WorkerMessage = { result?: { state: string }; error?: { name: string; message: string } };
const children = new Set<ReturnType<typeof spawn>>();

// The production processing entrypoint in a separate OS process. The caller controls retries here;
// analyze-shutdown.test.ts separately covers pg-boss delivery and graceful queue shutdown.
function worker(articleId: string) {
  const script = `
    import { processArticle } from '@aihot/backend/jobs/content';
    import { stopBoss } from '@aihot/backend/jobs/queue';
    import { closeDb } from '@aihot/backend/db';
    try {
      process.send({ result: await processArticle(process.env.TEST_ARTICLE_ID) });
    } catch (error) {
      process.send({ error: { name: error.constructor.name, message: error.message } });
    } finally {
      await stopBoss();
      await closeDb();
      process.disconnect();
    }
  `;
  const env: NodeJS.ProcessEnv = {
    ...process.env, TEST_ARTICLE_ID: articleId, MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "false",
    AIHOT_CREDENTIALS_DIR: "/nonexistent-test-credentials", FEISHU_INTERNAL_ENABLED: "false",
  };
  pointModels(provider.url, ["qwen3.7-flash", "glm-5.3-flash", "deepseek-flash", "mimo-v2.6-flash"], env);
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.add(child);
  let message: WorkerMessage | undefined;
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("message", (value: WorkerMessage) => { message = value; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; message: WorkerMessage | undefined; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { children.delete(child); resolve({ code, signal, message, stderr }); });
  });
  return { child, done };
}

async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timeout waiting for ${label}`);
    await delay(20);
  }
}

async function finish(articleId: string) {
  const result = await worker(articleId).done;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.message, "the processing child reported its result");
  return result.message;
}

async function kill(running: ReturnType<typeof worker>) {
  assert.equal(running.child.kill("SIGKILL"), true);
  const result = await running.done;
  assert.equal(result.signal, "SIGKILL", result.stderr);
  assert.equal(result.message, undefined, "the process was killed before completing business work");
}

async function article(scenario: string) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/analyze-kill-${T}/${scenario}`, title: `AI model release ${T} ${scenario}`,
    bodyText: `An AI lab released a new model with benchmarks and prices. ${T} ${scenario} ` + "The release explains model capabilities and evaluation results. ".repeat(10),
    bodyStatus: "ok", language: "en", via: "fetch", publishedAt: new Date(),
  });
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${SOURCE},'Analysis hard kill','rss','T1','editorial','2100-01-01')`;
});

after(async () => {
  holdPrefilter?.answer.open();
  for (const child of children) child.kill("SIGKILL");
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("SIGKILL after the provider accepted a request leaves an unknown outcome, released only once", async () => {
  calls = [];
  const articleId = await article("lost");
  const subject = `article:${articleId}@1`;
  const status = async () => (await sql`SELECT status FROM receipts WHERE subject=${subject}`)[0]?.status;

  const loseAnswer = async () => {
    holdPrefilter = { asked: gate(), answer: gate() };
    const running = worker(articleId);
    try {
      await Promise.race([holdPrefilter.asked.promise, running.done.then((r) => assert.fail(`child exited before request: ${JSON.stringify(r)}`))]);
      assert.equal(await status(), "pending", "request placeholder was committed before sending");
      await kill(running);
    } finally {
      holdPrefilter.answer.open();
      holdPrefilter = null;
    }
  };

  await loseAnswer();
  assert.equal((await finish(articleId)).result?.state, "waiting", "the request still in flight is waited for");
  assert.equal(await markStalePendingReceipts(), 0, "a recent pending receipt is still in flight");
  assert.deepEqual(calls, ["prefilter"], "restart does not immediately buy the lost answer again");

  // Age only the dedicated fixture's ledger: the test checks the 10/30 minute decisions without
  // claiming that wall time, process scheduling, or a seed is a deterministic simulation.
  await sql`UPDATE receipts SET updated_at=now()-interval '11 minutes' WHERE subject=${subject}`;
  assert.equal(await markStalePendingReceipts(), 1);
  assert.equal(await status(), "unknown");
  assert.equal((await finish(articleId)).result?.state, "unknown-receipt");
  assert.equal((await autoReleaseUnknownReceipts()).released, 0, "unknown waits another 30 minutes");
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE subject=${subject}`;
  assert.equal((await autoReleaseUnknownReceipts()).released, 1);
  assert.equal(await status(), "failed");

  await loseAnswer();
  await sql`UPDATE receipts SET updated_at=now()-interval '11 minutes' WHERE subject=${subject}`;
  assert.equal(await markStalePendingReceipts(), 1);
  await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE subject=${subject}`;
  assert.equal((await autoReleaseUnknownReceipts()).released, 0, "the second lost answer waits for an admin");
  assert.equal((await finish(articleId)).result?.state, "unknown-receipt");
  assert.deepEqual(calls, ["prefilter", "prefilter"], "only one automatic repeat was sent");
  const attempts = await sql`SELECT a.status FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.subject=${subject} ORDER BY a.attempt`;
  assert.deepEqual(attempts.map((a) => a.status), ["failed", "unknown"]);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${articleId}`).length, 0, "a lost answer cannot publish a partial result");
});

test("SIGKILL after responses are saved but before the business commit reuses all receipts on restart", async () => {
  calls = [];
  const articleId = await article("received");
  const subject = `article:${articleId}@1`;
  const locked = gate();
  const unlock = gate();
  // Hold the real business row, leaving receipt transactions free to commit. This is a precise
  // crash boundary without timing guesses or test-only hooks in the application.
  const transaction = sql.begin(async (tx) => {
    await tx`SELECT id FROM articles WHERE id=${articleId} FOR UPDATE`;
    locked.open();
    await unlock.promise;
  });
  try {
    await locked.promise;
    const running = worker(articleId);
    await until(async () => (await sql`SELECT 1 FROM receipts WHERE subject=${subject} AND status='received'`).length === 5, "all paid responses persisted");
    assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${articleId}`).length, 0);
    await kill(running);
  } finally {
    unlock.open();
    await transaction;
  }
  assert.deepEqual(calls.slice().sort(), ["prefilter", "score", "score", "structure", "understand"]);
  const receivedIds = (await sql`SELECT id FROM receipts WHERE subject=${subject} ORDER BY id`).map((r) => String(r.id));
  assert.equal((await finish(articleId)).result?.state, "pass");
  assert.equal(calls.length, 5, "restart sent no additional model requests");
  const [analysis] = await sql`SELECT selected,score,receipt_ids FROM analyses WHERE article_id=${articleId}`;
  assert.equal(analysis?.selected, true);
  assert.equal(Number(analysis?.score), SELECTING_SCORE);
  assert.deepEqual(analysis!.receipt_ids.map(String).sort(), receivedIds.slice().sort());
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${subject} AND status='completed'`).length, 5);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.subject=${subject}`).length, 5);
  assert.deepEqual({ ...(await sql`SELECT selected, selection_candidate FROM publications WHERE article_id=${articleId}`)[0] },
    { selected: false, selection_candidate: true }, "saved analysis nominates a candidate while news identity is pending");
});
