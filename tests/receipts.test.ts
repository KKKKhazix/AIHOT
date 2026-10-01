// Paid requests: an answer already received is reused, every request actually sent counts against the
// budget (retries of one logical request included), a lost answer is bought again at most once, and the
// valve stops calls before they are sent.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { embeddingsAvailable } from "@aihot/backend/providers/embeddings";
import { BudgetExceededError, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts, releaseReceipt } from "@aihot/backend/operations/recover";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";

const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
let answer: (hit: number) => string = () => '{"ok":true}';
const provider = await stub((hit) => ({ id: `stub-${hit}`, choices: [{ message: { content: answer(hit) } }], usage }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

const ask = (subject: string) =>
  chatJson({ model: "deepseek-flash", purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });

let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'deepseek'`;
});
after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'deepseek'`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("the migrations seed a budget for every paid service", async () => {
  const rows = await sql<{ service: string }[]>`SELECT service FROM budgets`;
  const services = new Set(rows.map((r) => r.service));
  for (const s of ["jina", "socialdata", "dajiala", "zhipu", "deepseek", "mimo", "dashscope"]) assert.ok(services.has(s), `no budget for ${s}`);
});

test("an answer already received is reused instead of bought again", async () => {
  answer = () => '{"ok":true}';
  const subject = `reuse-${tag()}`;
  const before = provider.hits();
  const first = await ask(subject);
  const second = await ask(subject);
  assert.equal(provider.hits() - before, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.receiptId, first.receiptId);
});

test("retries of unusable answers stop at the budget, and every request sent is counted", async () => {
  answer = () => "sorry, not json";
  const subject = `budget-${tag()}`;
  // Leave room for exactly two more requests in every window.
  const [c] = await sql<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS hour,
           count(*)::int AS day
    FROM receipt_attempts WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_minute = ${c!.minute + 2}, per_hour = ${c!.hour + 2}, per_day = ${c!.day + 2} WHERE service = 'deepseek'`;

  const before = provider.hits();
  const outcomes: string[] = [];
  const unusableReceiptIds: number[] = [];
  for (let i = 0; i < 5; i++) {
    // What a job retry does: the same logical request again.
    await ask(subject).then(
      () => outcomes.push("ok"),
      (error: unknown) => {
        if (error instanceof ModelOutputError) {
          assert.ok(error.receiptId, "a paid unusable response exposes its receipt");
          unusableReceiptIds.push(error.receiptId);
          outcomes.push("unusable");
        } else {
          outcomes.push(error instanceof BudgetExceededError ? "budget" : String(error));
        }
      },
    );
  }
  assert.equal(provider.hits() - before, 2, "requests sent");
  assert.deepEqual(outcomes, ["unusable", "unusable", "budget", "budget", "budget"]);
  assert.equal(new Set(unusableReceiptIds).size, 1, "retries keep the same logical receipt");
  const attempts = await sql<{ status: string; tokens: number }[]>`
    SELECT a.status, (a.usage->>'total_tokens')::int AS tokens
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject} ORDER BY a.attempt`;
  assert.deepEqual(attempts.map((a) => a.tokens), [100, 100], "each attempt keeps its own usage");
});

test("with the valve off nothing is sent", async () => {
  config.modelCallsEnabled = false;
  try {
    const before = provider.hits();
    await assert.rejects(ask(`valve-${tag()}`), /disabled/);
    assert.equal(provider.hits(), before);
    process.env.DASHSCOPE_API_KEY = "test-key";
    assert.equal(embeddingsAvailable(), false);
  } finally {
    config.modelCallsEnabled = true;
    delete process.env.DASHSCOPE_API_KEY;
  }
});

test("an unknown outcome is released automatically once, so a lost answer costs at most one repeat", async () => {
  // A service without a budget row: the budget tests above may have used up deepseek's.
  const req = { service: "invariant-unbudgeted", purpose: "invariant_test", subject: `lost-${tag()}`, identity: { lost: tag() } };
  let sent = 0;
  const lost = () => {
    sent += 1;
    return Promise.reject(new Error("socket hang up after sending"));
  };
  const status = async () => (await sql<{ status: string }[]>`SELECT status FROM receipts WHERE subject = ${req.subject}`)[0]!.status;
  const age = () => sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE subject = ${req.subject}`;

  await assert.rejects(paidRequest(req, lost));
  assert.equal(await status(), "unknown");
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "not within half an hour");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "failed");
  await assert.rejects(paidRequest(req, lost));
  assert.equal(sent, 2, "one repeat after the release");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "a second loss waits for the admin");
  await assert.rejects(paidRequest(req, lost), ReceiptUnknownError);
  assert.equal(sent, 2);
});

async function stoppedArticle(purpose: string, needsBody = false) {
  const key = tag();
  const sourceId = `recovery-${key}`;
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${sourceId}, 'Recovery', 'rss', '{"fetchPublicContent":true}')`;
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.com/recovery-${key}`, title: "Recovery", via: "fetch",
    bodyStatus: needsBody ? "pending" : "ok", bodyText: needsBody ? undefined : "body" });
  const subject = needsBody ? `article:${articleId}` : `article:${articleId}@1`;
  await assert.rejects(paidRequest({ service: "invariant-unbudgeted", purpose, subject, identity: { key } },
    () => Promise.reject(new Error("socket hang up after sending"))));
  await sql`UPDATE articles SET processing_state = 'failed', processing_attempts = 3,
    processing_retry_at = now() + interval '1 hour', processing_error = 'receipt outcome unknown' WHERE id = ${articleId}`;
  const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE subject = ${subject}`;
  return { articleId, receiptId: receipt!.id };
}

test("automatic release requeues the failed articles of all five analysis steps", async () => {
  const ids: string[] = [];
  for (const purpose of ["prefilter_article", "score_article", "understand_article", "summarize_article", "structure_article"]) {
    const { articleId, receiptId } = await stoppedArticle(purpose);
    ids.push(articleId);
    await sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE id = ${receiptId}`;
  }
  assert.deepEqual(await autoReleaseUnknownReceipts(), { released: 5, requeued: 5 });
  const rows = await sql<{ state: string; attempts: number; retry: Date | null; error: string | null }[]>`
    SELECT processing_state AS state, processing_attempts AS attempts, processing_retry_at AS retry, processing_error AS error
    FROM articles WHERE id = ANY(${ids}::text[])`;
  assert.equal(rows.length, ids.length);
  for (const row of rows) assert.deepEqual(row, { state: "new", attempts: 0, retry: null, error: null });
  const jobs = await sql`SELECT id FROM pgboss.job WHERE name = 'content.analyze' AND data->>'articleId' = ANY(${ids}::text[])`;
  assert.equal(jobs.length, ids.length, "each article has a real processing job");
  assert.deepEqual(await autoReleaseUnknownReceipts(), { released: 0, requeued: 0 }, "a released receipt is not queued twice");
});

test("manual release resumes pending body reads and leaves unrelated article work alone", async () => {
  for (const purpose of ["body_fallback", "x_article"]) {
    const { articleId, receiptId } = await stoppedArticle(purpose, true);
    const result = await releaseReceipt(receiptId, { billed: false, note: "checked the provider" }, "test");
    assert.equal(result?.requeued, true, purpose);
    const jobs = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${articleId}`;
    assert.deepEqual(jobs.map((j) => j.name), ["content.extract-body"], "the unfinished body is fetched before analysis");
  }
  const { articleId, receiptId } = await stoppedArticle("translate_body");
  assert.equal((await releaseReceipt(receiptId, { billed: false, note: "checked the provider" }, "test"))?.requeued, false);
  const [article] = await sql<{ state: string }[]>`SELECT processing_state AS state FROM articles WHERE id = ${articleId}`;
  assert.equal(article!.state, "failed", "translation is not a reason to rerun the editorial pipeline");
});
