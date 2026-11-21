// Failure modes: outages keep charging the primary; concurrent recovery probes flood it; a restart
// forgets the outage; a saved backup answer is bought again; timeouts lose their billing history;
// budget, input and output errors accidentally trigger a second provider.
import { pointModels, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { spawn } from "node:child_process";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, failureKind, ModelOutputError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { collectFindings } from "@aihot/backend/operations/alerts";
import { navCounts } from "@aihot/backend/admin/navigation";
import { runsOverview } from "@aihot/backend/admin/runs";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

const answer = (value: string) => ({ choices: [{ message: { content: JSON.stringify({ value }) } }] });
let primaryAnswer: () => unknown = () => answer("primary");
let backupAnswer: () => unknown = () => answer("backup");
const primary = await stub(() => primaryAnswer());
const backup = await stub(() => backupAnswer());
pointModels(primary.url, ["deepseek-flash", "glm-5.3-flash"]);
pointModels(backup.url, ["qwen3.8-flash"]);
const T = tag();
const request = (name: string) => ({
  model: "deepseek-flash", fallbackModel: "qwen3.8-flash", purpose: "summarize_article",
  subject: `failover:${T}:${name}`, promptVersion: "failover-test", system: "Return the requested value.",
  user: `${T}:${name}`, schema: z.object({ value: z.string() }),
});
beforeEach(async () => {
  await sql`DELETE FROM settings WHERE key LIKE 'model.circuit.%'`;
  primaryAnswer = () => answer("primary"); backupAnswer = () => answer("backup");
});
after(async () => { await Promise.all([primary.close(), backup.close()]); await stopBoss(); await closeDb(); });

test("a 503 uses the backup and a retry reuses its saved answer after the primary recovers", async () => {
  primaryAnswer = () => new Reply(503, { error: "overloaded" });
  const first = await chatJson(request("saved"));
  assert.equal(first.model, "qwen3.8-flash");
  assert.equal(first.data.value, "backup");
  primaryAnswer = () => answer("primary");
  const calls = [primary.hits(), backup.hits()];
  const again = await chatJson(request("saved"));
  assert.equal(again.receiptId, first.receiptId);
  assert.equal(again.reused, true);
  assert.deepEqual([primary.hits(), backup.hits()], calls);
});

test("ten consecutive failures within five minutes stop primary calls across steps and a fresh process, then one probe restores it", async () => {
  primaryAnswer = () => new Reply(503, { error: "overloaded" });
  const before = primary.hits();
  for (let i = 0; i < 9; i++) await chatJson(request(`trip-${i}`));
  assert.equal(primary.hits(), before + 9);
  assert.equal((await sql`SELECT value FROM settings WHERE key='model.circuit.deepseek'`)[0]!.value.openUntil, 0);
  await chatJson(request("trip-9"));
  const calls = primary.hits();
  const grouped = await chatJson({ ...request("group-during-outage"), purpose: "group_signal" });
  assert.equal(grouped.model, "qwen3.8-flash");
  assert.equal(primary.hits(), calls);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject = ${request("group-during-outage").subject} AND service = 'deepseek'`).length, 0,
    "an open circuit does not reserve budget or record an unsent attempt");
  const source = `import {z} from 'zod'; import {chatJson} from '@aihot/backend/providers/llm'; import {closeDb} from '@aihot/backend/db'; const r=await chatJson({...${JSON.stringify({ ...request("restart"), schema: undefined })},schema:z.object({value:z.string()})}); console.log(r.model); await closeDb();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errors = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  assert.equal(await new Promise(resolve => child.on("exit", resolve)), 0, errors);
  assert.match(output, /qwen3\.8-flash/);
  assert.equal(primary.hits(), calls);
  await sql`UPDATE settings SET value = jsonb_set(value, '{openUntil}', ${sql.json(Date.now() - 1)}) WHERE key = 'model.circuit.deepseek'`;
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  primaryAnswer = async () => { started(); await waiting; return answer("primary"); };
  const probe = chatJson(request("probe"));
  await entered;
  try {
    assert.equal((await chatJson(request("while-probing"))).model, "qwen3.8-flash");
    assert.equal(primary.hits(), calls + 1);
  } finally { release(); }
  assert.equal((await probe).model, "deepseek-flash");
  primaryAnswer = () => answer("primary");
  assert.equal((await chatJson(request("restored"))).model, "deepseek-flash");
  assert.equal(primary.hits(), calls + 2);
});

test("a failed recovery probe opens the circuit again without a new batch of primary attempts", async () => {
  primaryAnswer = () => new Reply(503, { error: "overloaded" });
  for (let i = 0; i < 10; i++) await chatJson(request(`reopen-${i}`));
  await sql`UPDATE settings SET value = jsonb_set(value, '{openUntil}', ${sql.json(Date.now() - 1)}) WHERE key = 'model.circuit.deepseek'`;
  const calls = primary.hits();
  await chatJson(request("failed-probe")); await chatJson(request("after-failed-probe"));
  assert.equal(primary.hits(), calls + 1);
});

test("a timed-out primary keeps its unknown receipt after the backup succeeds, and nothing asks anyone to release it", async () => {
  // The timeout is the backup's too: at 30 ms a busy CI runner's backup timed out as well and the test failed.
  primaryAnswer = () => new Promise(() => {});
  const result = await chatJson({ ...request("timeout"), timeoutMs: 300 });
  assert.equal(result.model, "qwen3.8-flash");
  const [original] = await sql`SELECT id, status, request, cost FROM receipts WHERE subject = ${request("timeout").subject} AND service = 'deepseek'`;
  assert.equal(original!.status, "unknown"); assert.equal(original!.cost, null);
  assert.equal(original!.request.fallbackReceiptId, result.receiptId);
  await sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE id = ${original!.id}`;
  assert.equal((await autoReleaseUnknownReceipts()).released, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE id = ${original!.id}`)[0]!.status, "unknown");
  // Kept unknown for billing only: not on the admin badge, the runs page's list or the alerts, where
  // such primaries would pile up and push out the receipts that do block work.
  assert.equal((await navCounts()).runs, 0);
  await getBoss(); // the runs page and the alerts read the job tables
  assert.equal((await runsOverview()).receipts.issues.some((receipt) => receipt.id === original!.id), false);
  assert.equal((await collectFindings()).some((finding) => finding.key === "receipts.unknown"), false);
});

test("a timeout at both providers stops and repeated work cannot buy a third request", async () => {
  primaryAnswer = backupAnswer = () => new Promise(() => {});
  const opts = { ...request("both-timeout"), timeoutMs: 30 };
  await assert.rejects(chatJson(opts), ReceiptUnknownError);
  const calls = [primary.hits(), backup.hits()];
  await assert.rejects(chatJson(opts), ReceiptUnknownError);
  assert.deepEqual([primary.hits(), backup.hits()], calls);
});

test("input rejection, unusable output and a stopped budget do not switch provider", async () => {
  const calls = backup.hits();
  primaryAnswer = () => new Reply(400, { error: "invalid input" });
  await assert.rejects(chatJson(request("bad-input")), /400/);
  primaryAnswer = () => ({ choices: [{ message: { content: "broken" } }] });
  await assert.rejects(chatJson(request("bad-output")), ModelOutputError);
  await sql`UPDATE settings SET value = jsonb_set(value, '{openUntil}', ${sql.json(Date.now() + 300_000)}) WHERE key = 'model.circuit.deepseek'`;
  await sql`UPDATE budgets SET per_day = 0 WHERE service = 'deepseek'`;
  try { await assert.rejects(chatJson(request("budget")), BudgetExceededError); }
  finally { await sql`UPDATE budgets SET per_day = 30000 WHERE service = 'deepseek'`; }
  assert.equal(backup.hits(), calls);
});

// A permanent 429 must not buy a fallback or trip the temporary-outage circuit. A real
// rate limit still uses the existing fallback policy and keeps the original attempt failed.
test("429 account refusals stop at the primary while temporary throttling can use the backup", async () => {
  const calls = backup.hits();
  primaryAnswer = () => new Reply(429, { error: { code: "1113", message: "account unavailable" } });
  const opts = { ...request("429-balance"), model: "glm-5.3-flash" };
  await assert.rejects(chatJson(opts), (error: unknown) => failureKind(error) === "refused");
  assert.equal(backup.hits(), calls);
  assert.equal((await sql`SELECT value FROM settings WHERE key='model.circuit.zhipu'`)[0]!.value.failures, 0);
  assert.equal((await sql`SELECT status FROM receipt_attempts WHERE service='zhipu' ORDER BY id DESC LIMIT 1`)[0]!.status, "failed");
  // A spent account pauses the service for a cooldown (providers/receipts.ts); the throttle below is
  // about a service that can still be called.
  await sql`DELETE FROM settings WHERE key='provider.stop.zhipu:glm-5.3-flash'`;
  primaryAnswer = () => new Reply(429, { error: { code: "1302", message: "请求频率过高" } });
  assert.equal((await chatJson({ ...opts, subject: `${opts.subject}-rate`, user: "rate-limited" })).model, "qwen3.8-flash");
  assert.equal(backup.hits(), calls + 1);
});
