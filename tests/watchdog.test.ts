// The worker watchdog in the api process: one alert when the heartbeat goes stale, none while it stays
// stale, one recovery when it comes back; a failed send is tried again at the next check.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { checkWorkerHeartbeat } from "@aihot/backend/operations/watch";

const T = tag();
const keys = ["heartbeat.worker", "watchdog.worker"];
const envNames = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ALERT_CHAT_ID", "FEISHU_INTERNAL_CHAT_ID", "FEISHU_INTERNAL_ENABLED"];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const attempts: string[] = [];
let failing = false;
const provider = await stub(async (_hit, req) => {
  if (req.url.endsWith("/auth/v3/tenant_access_token/internal")) return { code: 0, tenant_access_token: "fictional-token", expire: 7200 };
  const body = JSON.parse(req.body);
  assert.equal(body.receive_id, `oc_test_${T}`);
  attempts.push(JSON.parse(body.content).text as string);
  return failing ? { code: 99, msg: "synthetic send failure" } : { code: 0, data: { message_id: `message-${T}` } };
});
const realFetch = globalThis.fetch;
// Only the fictional Feishu transport goes to the local stub; any other destination is refused.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "https://open.feishu.cn");
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
  failing = false;
  process.env.FEISHU_APP_ID = "test-app";
  process.env.FEISHU_APP_SECRET = "test-secret";
  process.env.FEISHU_ALERT_CHAT_ID = `oc_test_${T}`;
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
