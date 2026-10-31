// What the owner is told (alerts, recoveries, reports) goes to the Webhook hub, which passes it on; the alert group
// gets it only when the hub doesn't take it. Failure cases: with the hub set up an alert also goes to the group; a
// long one reaches the owner cut differently or out of order, or two pieces share a key; a hub that refuses or can't
// be reached loses the alert; one that takes the first pieces of a long one and then refuses has the group sent the
// pieces the owner already has; the source key goes anywhere but the hub; with sending off anything goes out.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { sendAlert } from "@aihot/backend/notify/feishu";

const T = tag();
const envNames = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ALERT_CHAT_ID", "FEISHU_ALERT_WEBHOOK_URL", "FEISHU_INTERNAL_CHAT_ID",
  "FEISHU_INTERNAL_ENABLED", "WEBHOOK_HUB_URL", "WEBHOOK_HUB_KEY"];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const told: { auth: string | null; key: string; text: string }[] = [];
const grouped: string[] = [];
let hub: "up" | "refusing" | "down" | "takes one" = "up";
// Outside production every alert names its environment first.
const unlabelled = (text: string) => text.replace(/^【[^】]+】/, "");
const feishu = await stub(async (_hit, req) => {
  if (req.url.endsWith("/auth/v3/tenant_access_token/internal")) return { code: 0, tenant_access_token: "fictional-token", expire: 7200 };
  // The app sends content as a JSON string, the group's bot webhook as an object.
  const content = JSON.parse(req.body).content;
  grouped.push((typeof content === "string" ? JSON.parse(content) : content).text as string);
  return { code: 0, data: { message_id: `message-${T}` } };
});
const hubStub = await stub(async () => (hub === "refusing" || (hub === "takes one" && told.length > 1) ? new Reply(503, { error: "restarting" }) : { duplicate: false }));
const realFetch = globalThis.fetch;
// The hub and Feishu are the only destinations; each goes to its local stub.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://hub.test") {
    assert.equal(url.pathname, "/tell");
    told.push({ auth: new Headers(init?.headers).get("authorization"), ...JSON.parse(String(init?.body)) });
    if (hub === "down") throw new TypeError("fetch failed");
    return realFetch(`${hubStub.url}${url.pathname}`, init);
  }
  assert.equal(url.origin, "https://open.feishu.cn");
  assert.equal(new Headers(init?.headers).get("authorization")?.includes(`source-key-${T}`) ?? false, false, "the source key goes to the hub alone");
  return realFetch(`${feishu.url}${url.pathname}${url.search}`, init);
}) as typeof fetch;

beforeEach(() => {
  told.length = 0;
  grouped.length = 0;
  hub = "up";
  process.env.FEISHU_APP_ID = "test-app";
  process.env.FEISHU_APP_SECRET = "test-secret";
  process.env.FEISHU_ALERT_CHAT_ID = `oc_test_${T}`;
  delete process.env.FEISHU_ALERT_WEBHOOK_URL;
  delete process.env.FEISHU_INTERNAL_CHAT_ID;
  process.env.FEISHU_INTERNAL_ENABLED = "true";
  process.env.WEBHOOK_HUB_URL = "https://hub.test/events";
  process.env.WEBHOOK_HUB_KEY = `source-key-${T}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await Promise.all([feishu.close(), hubStub.close()]);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await closeDb();
});

test("with the hub set up, an alert goes to the hub's /tell with the source key, and not to the group", async () => {
  assert.equal(await sendAlert("🔴 网站停止收录", ["影响：读者看不到新内容"]), "sent");
  assert.equal(told.length, 1);
  assert.equal(told[0]!.auth, `Bearer source-key-${T}`);
  assert.match(told[0]!.key, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.equal(unlabelled(told[0]!.text), "🔴 网站停止收录\n影响：读者看不到新内容");
  assert.deepEqual(grouped, []);
});

test("a long report reaches him in pieces, in order, each under its own key", async () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `第 ${i} 行：某个信源这一周的抓取情况和处理结果`);
  assert.equal(await sendAlert("📊 信源周报", lines), "sent");
  assert.ok(told.length > 1);
  assert.equal(unlabelled(told.map((piece) => piece.text).join("")), ["📊 信源周报", ...lines].join("\n"));
  assert.equal(new Set(told.map((piece) => piece.key)).size, told.length);
  assert.ok(told.every((piece) => [...piece.text].length <= 20_000), "each piece is within what the hub takes");
  assert.deepEqual(grouped, []);
});

test("when the hub refuses or can't be reached, the alert goes to the group as before", async () => {
  for (const state of ["refusing", "down"] as const) {
    told.length = 0;
    grouped.length = 0;
    hub = state;
    assert.equal(await sendAlert("🟠 有服务快到期了", ["域名 11-06 到期"]), "sent");
    assert.equal(told.length, 1, state);
    assert.deepEqual(grouped.map(unlabelled), ["🟠 有服务快到期了\n域名 11-06 到期"], state);
  }
});

test("when the hub takes the first piece of a long report and then refuses, the group gets only the rest", async () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `第 ${i} 行：某个信源这一周的抓取情况和处理结果`);
  for (const group of ["chat", "bot webhook"] as const) {
    told.length = 0;
    grouped.length = 0;
    hub = "takes one";
    if (group === "bot webhook") process.env.FEISHU_ALERT_WEBHOOK_URL = `https://open.feishu.cn/open-apis/bot/v2/hook/test-${T}`;
    assert.equal(await sendAlert("📊 信源周报", lines), "sent");
    assert.equal(told.length, 2, group);
    assert.ok(grouped.length > 0, group);
    assert.equal(unlabelled(told[0]!.text + grouped.join("")), ["📊 信源周报", ...lines].join("\n"), group);
  }
});

test("with sending off nothing goes out, to the hub or the group", async () => {
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  assert.equal(await sendAlert("🔴 测试", ["不该发出"]), "disabled");
  assert.deepEqual(told, []);
  assert.deepEqual(grouped, []);
});
