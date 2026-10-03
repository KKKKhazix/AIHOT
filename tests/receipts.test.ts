// Paid requests: an answer already received is reused, every request actually sent counts against the
// budget (retries of one logical request included), a lost answer is bought again at most once, and the
// valve stops calls before they are sent.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { embeddingsAvailable } from "@aihot/backend/providers/embeddings";
import { BudgetExceededError, logicalKeyFor, markStalePendingReceipts, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";

const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
let answer: (hit: number) => string = () => '{"ok":true}';
const provider = await stub((hit) => ({ id: `stub-${hit}`, choices: [{ message: { content: answer(hit) } }], usage }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

const ask = (subject: string) =>
  chatJson({ model: "deepseek-flash", purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });

after(async () => {
  await provider.close();
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

test("stale recovery waiting on a response transaction preserves its committed answer and attempt", async () => {
  const request = { service: "invariant-recovery-race", purpose: "invariant_test", identity: { race: tag() } };
  const asked = gate();
  const answer = gate();
  let sent = 0;
  const first = paidRequest(request, async () => {
    sent += 1;
    asked.open();
    await answer.promise;
    return { response: { saved: true } };
  });
  await asked.promise;
  const [row] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key = ${logicalKeyFor(request)}`;
  await sql`UPDATE receipts SET updated_at = now() - interval '11 minutes' WHERE id = ${row!.id}`;

  // Hold only the attempt row: paidRequest can write its received response, but cannot commit yet.
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT id FROM receipt_attempts WHERE receipt_id = ${row!.id} FOR UPDATE`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  const waitingOn = async (query: string) => {
    for (let i = 0; i < 500; i++) {
      const waiting = await sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${query}`;
      if (waiting.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`transaction never waited on ${query}`);
  };
  let sweep: Promise<number> | undefined;
  try {
    answer.open();
    await waitingOn("%UPDATE receipt_attempts SET%");
    sweep = markStalePendingReceipts();
    await waitingOn("%UPDATE receipts SET status =%");
  } finally {
    release.open();
    await blocker;
  }
  await first;
  assert.equal(await sweep, 0, "a completed response no longer counts as stale pending");
  const again = await paidRequest(request, async () => {
    sent += 1;
    return { response: { saved: false } };
  });
  assert.equal(sent, 1);
  assert.equal(again.reused, true);
  assert.deepEqual(again.response, { saved: true });
  const [attempt] = await sql<{ status: string }[]>`SELECT status FROM receipt_attempts WHERE receipt_id = ${row!.id}`;
  assert.equal(attempt!.status, "received");
});

test("a fully received non-object model response is unusable output, not an unknown paid outcome", async () => {
  const malformed = await stub(() => null);
  const original = process.env.DEEPSEEK_BASE_URL;
  const subject = `malformed-${tag()}`;
  process.env.DEEPSEEK_BASE_URL = `${malformed.url}/v1`;
  try {
    await assert.rejects(ask(subject), ModelOutputError);
    const [r] = await sql`SELECT status,response FROM receipts WHERE subject=${subject}`;
    assert.equal(r!.status, "failed");
    assert.equal(r!.response.unparsable, "null", "the received provider payload remains inspectable");
    assert.equal(malformed.hits(), 1);
  } finally {
    process.env.DEEPSEEK_BASE_URL = original;
    await malformed.close();
  }
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
  for (let i = 0; i < 5; i++) {
    // What a job retry does: the same logical request again.
    await ask(subject).then(
      () => outcomes.push("ok"),
      (error: unknown) => outcomes.push(error instanceof ModelOutputError ? "unusable" : error instanceof BudgetExceededError ? "budget" : String(error)),
    );
  }
  assert.equal(provider.hits() - before, 2, "requests sent");
  assert.deepEqual(outcomes, ["unusable", "unusable", "budget", "budget", "budget"]);
  const attempts = await sql<{ status: string; tokens: number }[]>`
    SELECT a.status, (a.usage->>'total_tokens')::int AS tokens
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject} ORDER BY a.attempt`;
  assert.deepEqual(attempts.map((a) => a.tokens), [100, 100], "each attempt keeps its own usage");
});

// Failure mode: two workers can both see the last budget slot before either saves its attempt.
test("concurrent distinct requests cannot both spend the last service budget slot", async () => {
  const service = `invariant-concurrent-budget-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 1, 100, 100)`;
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    // Reads still run, but an attempt cannot commit until both workers reach a database lock.
    await tx`LOCK TABLE receipt_attempts IN SHARE MODE`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  let sent = 0;
  const send = async () => { sent += 1; return { response: { ok: true } }; };
  const outcomes: Promise<PromiseSettledResult<unknown>>[] = [];
  const request = (identity: string) => {
    outcomes.push(paidRequest({ service, purpose: "invariant_test", identity }, send).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ));
  };
  const waitForBlocked = async (count: number) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`;
      if (rows.length === count) return;
      assert.ok(Date.now() < deadline, `expected ${count} requests at the database barrier, saw ${rows.length}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    request("first");
    await waitForBlocked(1);
    request("second");
    await waitForBlocked(2);
  } finally {
    release.open();
    await blocker;
  }
  const results = await Promise.all(outcomes);
  assert.equal(sent, 1, "only one request may reach the paid provider");
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof BudgetExceededError));
  const [attempts] = await sql<{ count: number }[]>`SELECT count(*) FROM receipt_attempts WHERE service = ${service}`;
  assert.equal(attempts!.count, 1, "the refused request must not reserve another paid attempt");
});

// Failure modes: checking only the shortest window loses sustained-spend limits; counting expired
// attempts never restores the allowance. Exercise each longer window without exhausting the others.
for (const window of [
  { name: "hour", insideMs: 2 * 60_000, expiredMs: 61 * 60_000, perHour: 1, perDay: 100 },
  { name: "day", insideMs: 2 * 3_600_000, expiredMs: 25 * 3_600_000, perHour: 100, perDay: 1 },
]) test(`the ${window.name} budget independently refuses a paid request until its attempt expires`, async () => {
  const service = `invariant-${window.name}-budget-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
    VALUES (${service}, 100, ${window.perHour}, ${window.perDay})`;
  let sent = 0;
  const send = async () => { sent += 1; return { response: { ok: true } }; };
  const first = await paidRequest({ service, purpose: "invariant_test", identity: "first" }, send);
  await sql`UPDATE receipt_attempts SET started_at = ${new Date(Date.now() - window.insideMs)} WHERE receipt_id = ${first.receiptId}`;

  const next = { service, purpose: "invariant_test", identity: "next" };
  await assert.rejects(paidRequest(next, send), BudgetExceededError);
  assert.equal(sent, 1, "the exhausted window prevents sending, even when the other windows have room");

  await sql`UPDATE receipt_attempts SET started_at = ${new Date(Date.now() - window.expiredMs)} WHERE receipt_id = ${first.receiptId}`;
  const resumed = await paidRequest(next, send);
  assert.equal(resumed.reused, false);
  assert.equal(sent, 2, "an expired attempt no longer consumes the service allowance");
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
