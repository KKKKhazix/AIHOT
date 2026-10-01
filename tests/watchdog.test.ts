import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { checkWorkerHeartbeat } from "@aihot/backend/operations/watch";
import { beijingStamp } from "@aihot/backend/notify/feishu";

const T = tag();
const keys = ["heartbeat.worker", "watchdog.worker"];
const envNames = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ALERT_CHAT_ID", "FEISHU_INTERNAL_CHAT_ID", "FEISHU_INTERNAL_ENABLED"];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
let saved: Array<{ key: string; value: unknown; updated_by: string; updated_at: Date }> = [];
const attempts: string[] = [];
const success = () => ({ code: 0, data: { message_id: `message-${T}` } });
let answer: (text: string) => Promise<unknown> = async () => success();
let loseResponse = false;
const provider = await stub(async (_hit, req) => {
  if (req.url.endsWith("/auth/v3/tenant_access_token/internal")) return { code: 0, tenant_access_token: "fictional-token", expire: 7200 };
  assert.ok(req.url.includes("/im/v1/messages"));
  const body = JSON.parse(req.body);
  assert.equal(body.receive_id, `oc_test_${T}`);
  const text = JSON.parse(body.content).text as string;
  attempts.push(text);
  return answer(text);
});
const realFetch = globalThis.fetch;
// 只把虚构飞书传输转到本地服务；任何其他请求都拒绝，不接触真实目的地。
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "https://open.feishu.cn");
  const result = await realFetch(`${provider.url}${url.pathname}${url.search}`, init);
  if (loseResponse && url.pathname.endsWith("/im/v1/messages")) throw new Error("synthetic timeout after remote acceptance");
  return result;
}) as typeof fetch;

interface Notice { id: string; state: "down" | "up"; since: string; at: string }
interface WatchState { state: "down" | "up"; since: string; pending?: Notice[]; lease?: { token: string; until: string } }
async function state() {
  return (await sql<{ value: WatchState }[]>`SELECT value FROM settings WHERE key='watchdog.worker'`)[0]?.value;
}
async function heartbeat(stale: boolean) {
  const at = new Date(Date.now() - (stale ? 61 * 60_000 : 0));
  await sql`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('heartbeat.worker','{}','test',${at})
    ON CONFLICT(key) DO UPDATE SET updated_at=EXCLUDED.updated_at`;
  return at;
}
async function expireLease() {
  assert.ok((await state())?.lease, "a send owns a durable lease before it starts");
  await sql`UPDATE settings SET value=jsonb_set(value,'{lease,until}',${sql.json(new Date(Date.now() - 1000).toISOString())}) WHERE key='watchdog.worker'`;
}
function childCheck() {
  const code = `
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'https://open.feishu.cn') throw new Error('unexpected external request');
      return realFetch(${JSON.stringify(provider.url)} + url.pathname + url.search, init);
    };
    const { checkWorkerHeartbeat } = await import('@aihot/backend/operations/watch');
    const { closeDb } = await import('@aihot/backend/db');
    try { await checkWorkerHeartbeat(); } finally { await closeDb(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, done };
}

before(async () => {
  saved = await sql`SELECT key,value,updated_by,updated_at FROM settings WHERE key=ANY(${keys})`;
});
beforeEach(async () => {
  await sql`DELETE FROM settings WHERE key=ANY(${keys})`;
  attempts.length = 0;
  answer = async () => success();
  loseResponse = false;
  process.env.FEISHU_APP_ID = "test-app";
  process.env.FEISHU_APP_SECRET = "test-secret";
  process.env.FEISHU_ALERT_CHAT_ID = `oc_test_${T}`;
  delete process.env.FEISHU_INTERNAL_CHAT_ID;
  process.env.FEISHU_INTERNAL_ENABLED = "true";
});
after(async () => {
  globalThis.fetch = realFetch;
  await provider.close();
  await sql`DELETE FROM settings WHERE key=ANY(${keys})`;
  for (const row of saved) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${row.key},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await closeDb();
});

test("a failed down notification retries unchanged state and stable success is not repeated", async () => {
  await heartbeat(true);
  answer = async () => ({ code: 99, msg: "synthetic send failure" });
  await assert.rejects(checkWorkerHeartbeat(), /synthetic send failure/);
  answer = async () => success();
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 2, "the unchanged down state must retry the undelivered notification");
  assert.equal(attempts[0], attempts[1], "retry retains incident identity and recorded timestamps");
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 2);
  assert.deepEqual((await state())!.pending, []);
  assert.equal((await state())!.lease, undefined);
});

for (const reason of ["disabled", "missing destination"]) test(`${reason} does not consume the down transition`, async () => {
  await heartbeat(true);
  if (reason === "disabled") process.env.FEISHU_INTERNAL_ENABLED = "false";
  else delete process.env.FEISHU_ALERT_CHAT_ID;
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 0);
  process.env.FEISHU_INTERNAL_ENABLED = "true";
  process.env.FEISHU_ALERT_CHAT_ID = `oc_test_${T}`;
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 1, "enabling later sends the original pending state change");
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 1);
});

test("separate API processes cannot both send under an active lease", async () => {
  await heartbeat(true);
  const started = gate();
  const release = gate();
  answer = async () => { started.open(); await release.promise; return success(); };
  const first = childCheck();
  try {
    await started.promise;
    const lease = (await state())!.lease;
    assert.ok(lease);
    assert.ok(Date.parse(lease.until) > Date.now() && Date.parse(lease.until) <= Date.now() + 120_000);
    const second = await childCheck().done;
    assert.equal(second.code, 0, second.stderr);
    assert.equal(attempts.length, 1);
  } finally {
    release.open();
    const completed = await first.done;
    assert.equal(completed.code, 0, completed.stderr);
  }
  assert.deepEqual((await state())!.pending, []);
});

test("a killed checker leaves a reclaimable lease and the same notification identity", async () => {
  await heartbeat(true);
  const started = gate();
  const release = gate();
  answer = async () => { started.open(); await release.promise; return success(); };
  const owner = childCheck();
  try {
    await started.promise;
    const before = await state();
    assert.ok(before?.lease);
    const id = before.pending![0]!.id;
    owner.child.kill("SIGKILL");
    assert.equal((await owner.done).signal, "SIGKILL");
    release.open();
    answer = async () => success();
    await checkWorkerHeartbeat();
    assert.equal(attempts.length, 1, "a crashed owner's unexpired lease still prevents another send");
    await expireLease();
    await checkWorkerHeartbeat();
    assert.equal(attempts.length, 2);
    assert.ok(attempts[1]!.includes(id));
    assert.deepEqual((await state())!.pending, []);
  } finally {
    release.open();
    if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill("SIGKILL");
    await owner.done;
  }
});

for (const oldFails of [false, true]) test(`late old ${oldFails ? "failure" : "success"} cannot clear a reclaimed lease or queued recovery`, async () => {
  await heartbeat(true);
  const firstStarted = gate();
  const secondStarted = gate();
  const firstRelease = gate();
  const secondRelease = gate();
  let sends = 0;
  answer = async () => {
    sends++;
    if (sends === 1) { firstStarted.open(); await firstRelease.promise; return oldFails ? { code: 99, msg: "late failure" } : success(); }
    if (sends === 2) { secondStarted.open(); await secondRelease.promise; }
    return success();
  };
  const first = checkWorkerHeartbeat();
  const firstResult = first.then(() => null, (error: unknown) => error);
  let second: Promise<void> | undefined;
  try {
    await firstStarted.promise;
    await expireLease();
    second = checkWorkerHeartbeat();
    await secondStarted.promise;
    const token = (await state())!.lease!.token;
    await heartbeat(false);
    await checkWorkerHeartbeat();
    assert.equal((await state())!.pending!.length, 2);
    firstRelease.open();
    assert.equal((await firstResult) instanceof Error, oldFails);
    const fenced = (await state())!;
    assert.equal(fenced.lease!.token, token);
    assert.deepEqual(fenced.pending!.map((p) => p.state), ["down", "up"]);
    secondRelease.open();
    await second;
    assert.deepEqual((await state())!.pending!.map((p) => p.state), ["up"]);
    await checkWorkerHeartbeat();
    assert.equal(attempts.length, 3);
    assert.ok(attempts[2]!.includes("已恢复"));
    assert.deepEqual((await state())!.pending, []);
  } finally {
    firstRelease.open(); secondRelease.open();
    await firstResult; await second;
  }
});

test("a lost response after remote acceptance is retried at least once with a stable identity", async () => {
  await heartbeat(true);
  loseResponse = true;
  await assert.rejects(checkWorkerHeartbeat(), /synthetic timeout after remote acceptance/);
  loseResponse = false;
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 2, "uncertain remote success may be duplicated");
  assert.equal(attempts[0], attempts[1]);
  assert.deepEqual((await state())!.pending, []);
});

test("recovery while a down send is pending is independently delivered in order", async () => {
  const since = await heartbeat(true);
  answer = async () => ({ code: 99, msg: "first failed" });
  await assert.rejects(checkWorkerHeartbeat());
  await heartbeat(false);
  answer = async () => success();
  await checkWorkerHeartbeat();
  assert.ok(!attempts[1]!.includes("已恢复"), "the undelivered down transition remains first");
  const pending = (await state())!.pending!;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.state, "up");
  assert.equal(pending[0]!.since, since.toISOString());
  await checkWorkerHeartbeat();
  assert.ok(attempts[2]!.includes("已恢复"));
  assert.ok(attempts[2]!.includes(beijingStamp(since)));
  assert.ok(attempts[2]!.includes(pending[0]!.id));
  assert.deepEqual((await state())!.pending, []);
});

test("down recovery and another outage drain FIFO with distinct identities", async () => {
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  await heartbeat(true); await checkWorkerHeartbeat();
  await heartbeat(false); await checkWorkerHeartbeat();
  await heartbeat(true); await checkWorkerHeartbeat();
  const queued = (await state())!.pending!;
  assert.deepEqual(queued?.map((p) => p.state), ["down", "up", "down"]);
  assert.equal(new Set(queued.map((p) => p.id)).size, 3);
  process.env.FEISHU_INTERNAL_ENABLED = "true";
  for (const notice of queued) {
    await checkWorkerHeartbeat();
    assert.ok(attempts.at(-1)!.includes(notice.id));
  }
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((s) => s.includes("已恢复")), [false, true, false]);
  assert.deepEqual((await state())!.pending, []);
});

test("healthy initialization and missing first heartbeat remain silent", async () => {
  await checkWorkerHeartbeat();
  assert.equal(await state(), undefined);
  await heartbeat(false);
  await checkWorkerHeartbeat();
  await checkWorkerHeartbeat();
  assert.equal((await state())!.state, "up");
  assert.equal(attempts.length, 0);
});

test("legacy state is not replayed but its next transition is retryable", async () => {
  const since = await heartbeat(true);
  await sql`INSERT INTO settings(key,value,updated_by) VALUES('watchdog.worker',${sql.json({ state: "down", since: since.toISOString() })},'test')`;
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 0);
  await heartbeat(false);
  answer = async () => ({ code: 99, msg: "recovery failed" });
  await assert.rejects(checkWorkerHeartbeat());
  answer = async () => success();
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.ok(attempts[1]!.includes("已恢复"));
  assert.ok(attempts[1]!.includes(beijingStamp(since)));
});
