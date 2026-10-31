// The worker watchdog in the api process: one alert when the heartbeat goes stale, none while it stays
// stale, one recovery when it comes back; a failed send is tried again at the next check.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { checkWorkerHeartbeat } from "@aihot/backend/operations/watch";
import { sendAlert } from "@aihot/backend/notify/feishu";

const T = tag();
const keys = ["heartbeat.worker", "watchdog.worker"];
const envNames = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ALERT_CHAT_ID", "FEISHU_ALERT_WEBHOOK_URL", "FEISHU_INTERNAL_CHAT_ID", "FEISHU_INTERNAL_ENABLED"];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const attempts: string[] = [];
const hooked: string[] = [];
// When Feishu got each webhook request: the custom bot's limits are counted there.
const hookedAt: number[] = [];
// Milliseconds the next webhook request takes to reach Feishu.
let hookDelay = 0;
const hookedBytes: number[] = [];
let failing = false;
const provider = await stub(async (_hit, req) => {
  if (req.url.endsWith("/auth/v3/tenant_access_token/internal")) return { code: 0, tenant_access_token: "fictional-token", expire: 7200 };
  const body = JSON.parse(req.body);
  if (req.url.endsWith(`/bot/v2/hook/test-${T}`)) {
    assert.equal(body.msg_type, "text");
    hooked.push(body.content.text as string);
    hookedAt.push(performance.now());
    hookedBytes.push(Buffer.byteLength(req.body));
    return failing ? { code: 19001, msg: "synthetic webhook failure" } : { StatusCode: 0, code: 0, msg: "success" };
  }
  assert.equal(body.receive_id, `oc_test_${T}`);
  attempts.push(JSON.parse(body.content).text as string);
  return failing ? { code: 99, msg: "synthetic send failure" } : { code: 0, data: { message_id: `message-${T}` } };
});
const realFetch = globalThis.fetch;
// Only the fictional Feishu transport goes to the local stub; any other destination is refused.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "https://open.feishu.cn");
  if (url.pathname === `/open-apis/bot/v2/hook/test-${T}` && hookDelay) {
    const ms = hookDelay;
    hookDelay = 0;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  return realFetch(`${provider.url}${url.pathname}${url.search}`, init);
}) as typeof fetch;

async function heartbeat(stale: boolean) {
  const at = new Date(Date.now() - (stale ? 61 * 60_000 : 0));
  await sql`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('heartbeat.worker','{}','test',${at})
    ON CONFLICT(key) DO UPDATE SET updated_at=EXCLUDED.updated_at`;
}

beforeEach(async () => {
  await sql`DELETE FROM settings WHERE key=ANY(${keys})`;
  attempts.length = 0;
  hooked.length = 0;
  hookedAt.length = 0;
  hookDelay = 0;
  hookedBytes.length = 0;
  failing = false;
  process.env.FEISHU_APP_ID = "test-app";
  process.env.FEISHU_APP_SECRET = "test-secret";
  process.env.FEISHU_ALERT_CHAT_ID = `oc_test_${T}`;
  delete process.env.FEISHU_ALERT_WEBHOOK_URL;
  delete process.env.FEISHU_INTERNAL_CHAT_ID;
  process.env.FEISHU_INTERNAL_ENABLED = "true";
});
after(async () => {
  globalThis.fetch = realFetch;
  await provider.close();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await closeDb();
});

test("one alert when the worker stops, none while it stays stopped, one recovery when it is back", async () => {
  await heartbeat(false);
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 0, "a first check that finds the worker running only records it");
  await heartbeat(true);
  await checkWorkerHeartbeat();
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 1);
  assert.match(attempts[0]!, /后台处理服务停了/);
  await heartbeat(false);
  await checkWorkerHeartbeat();
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 2);
  assert.match(attempts[1]!, /已恢复/);
});

test("a failed send is tried again at the next check", async () => {
  await heartbeat(true);
  failing = true;
  await assert.rejects(checkWorkerHeartbeat(), /synthetic send failure/);
  failing = false;
  await checkWorkerHeartbeat();
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 2, "the failed alert goes out at the next check, and only then");
  assert.ok(attempts.every((text) => text.includes("后台处理服务停了")));
});

test("with an alert webhook, alerts go to the group bot alone and need no message app", async () => {
  process.env.FEISHU_ALERT_WEBHOOK_URL = `https://open.feishu.cn/open-apis/bot/v2/hook/test-${T}`;
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  await heartbeat(true);
  failing = true;
  await assert.rejects(checkWorkerHeartbeat(), /synthetic webhook failure/);
  failing = false;
  await checkWorkerHeartbeat();
  assert.equal(attempts.length, 0, "nothing goes through the message app");
  assert.equal(hooked.length, 2, "a refused webhook send is tried again at the next check");
  assert.ok(hooked.every((text) => text.includes("后台处理服务停了")));
});

test("the alert webhook keeps within the custom bot's limits: 20 KB a request, 100 requests a minute", async () => {
  process.env.FEISHU_ALERT_WEBHOOK_URL = `https://open.feishu.cn/open-apis/bot/v2/hook/test-${T}`;
  const lines = Array.from({ length: 900 }, (_, i) => `第 ${i} 个信源：连续抓取失败，读者看不到它的新内容`);
  lines.push("长".repeat(9000));
  lines.push(...Array.from({ length: 400 }, () => String.raw`详情：{"error":"\"bad\" \\path\\"}`));
  await sendAlert("系统日报", lines);
  assert.ok(hooked.length >= 3);
  assert.ok(hookedBytes.every((n) => n <= 20 * 1024), `request sizes ${hookedBytes.join(", ")}`);
  assert.match(hooked.join(""), /^(【[^】]+】)?系统日报\n/);
  assert.ok(hooked.join("").endsWith(`系统日报\n${lines.join("\n")}`), "the pieces are the whole text, in order");
  for (let i = 1; i < hookedAt.length; i++) assert.ok(hookedAt[i]! - hookedAt[i - 1]! >= 600, `at most 100 a minute: gaps ${gaps()}`);
});

// A late timer, a busy process or a slow network: none of them may bring two requests closer at Feishu.
test("a request that reaches Feishu late still leaves 600 ms before the next one", async () => {
  process.env.FEISHU_ALERT_WEBHOOK_URL = `https://open.feishu.cn/open-apis/bot/v2/hook/test-${T}`;
  hookDelay = 300;
  await sendAlert("系统日报", Array.from({ length: 900 }, (_, i) => `第 ${i} 个信源：连续抓取失败，读者看不到它的新内容`));
  assert.ok(hookedAt.length >= 3);
  for (let i = 1; i < hookedAt.length; i++) assert.ok(hookedAt[i]! - hookedAt[i - 1]! >= 600, `gaps ${gaps()}`);
});

function gaps() {
  return hookedAt.slice(1).map((t, i) => Math.round(t - hookedAt[i]!)).join(", ");
}
