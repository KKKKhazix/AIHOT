// Feedback reaches the internal Feishu chat with its screenshot even when Feishu fails at first: a
// failed upload or send is tried again, only the Feishu image key is kept, a screenshot that cannot be
// uploaded for a day, or that Feishu refuses outright, is dropped (the text still goes), screenshots left
// behind are removed after a week, and imported feedback is never forwarded again. Without the chat a
// screenshot is the only copy: it stays.
// Handling records what each feedback is (a bug, a suggestion, a question or other), and suggestions that
// name the same idea add up by sender, so the admin sees what readers ask for most. The pool lists every
// idea: handling names a suggestion after the names in it, and one missing would get a second name.
// Before a report is pushed a cheap model reads it: one with nothing in it is marked spam and not pushed,
// and a model that cannot answer never holds a report back.
// A report from a page a module takes itself stays out of the chat; its screenshot still goes to Feishu, and
// whoever handles a report reads the screenshot back from wherever it is.
import { pointModels, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { listFeedback, readFeedbackScreenshot, updateFeedback } from "@aihot/backend/admin/feedback";
import { Conflict } from "@aihot/backend/audit";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { forwardFeedbackToFeishu } from "@aihot/backend/notify/feishu";
import { defineServerModule, installModules } from "@aihot/backend/modules";
import { forwardPendingFeedback, sniffImageType, submitFeedback } from "@aihot/backend/operations/feedback";
import { dailyRetention } from "@aihot/backend/operations/retention";

const T = tag();
config.dataDir = mkdtempSync(path.join(tmpdir(), "aihot-feedback-"));
process.env.FEISHU_APP_ID = "test-app";
process.env.FEISHU_APP_SECRET = "test-secret";
process.env.FEISHU_INTERNAL_CHAT_ID = "oc_test";

// Feishu's message app, answered here: uploads and sends fail while the switches say so.
const feishu = { uploadFails: false, uploadRefused: false, uploads: 0, uploaded: null as Buffer | null, sendFails: false, sent: [] as Array<{ title: string; content: unknown[][] }> };
const MODEL_URL = "https://model.test/v1";
const model = { noise: false, fails: false, calls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(MODEL_URL)) {
    model.calls += 1;
    if (model.fails) return new Response("down", { status: 500 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ noise: model.noise }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }
  if (!url.startsWith("https://open.feishu.cn/")) return realFetch(input, init);
  if (url.endsWith("/auth/v3/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "t", expire: 7200 });
  if (url.endsWith("/im/v1/images")) {
    feishu.uploads += 1;
    if (feishu.uploadRefused) return Response.json({ code: 234011, msg: "Can't regonise the image format." }, { status: 400 });
    if (feishu.uploadFails) return Response.json({ code: 99, msg: "upload broken" });
    feishu.uploaded = Buffer.from(await ((init!.body as FormData).get("image") as Blob).arrayBuffer());
    return Response.json({ code: 0, data: { image_key: `img_${T}` } });
  }
  if (url.endsWith(`/im/v1/images/img_${T}`)) return new Response(new Uint8Array(feishu.uploaded!), { headers: { "content-type": "image/png" } });
  if (url.includes("/im/v1/messages")) {
    if (feishu.sendFails) return Response.json({ code: 99, msg: "send broken" });
    const content = JSON.parse(JSON.parse(String(init?.body)).content).zh_cn;
    feishu.sent.push(content);
    return Response.json({ code: 0, data: { message_id: "m1" } });
  }
  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

let n = 0;
async function submit(): Promise<{ id: number; file: string }> {
  n += 1;
  // Submitted while forwarding is off, so the test drives every attempt itself.
  delete process.env.FEISHU_INTERNAL_ENABLED;
  const { id } = await submitFeedback({ content: `反馈 ${T}-${n}`, screenshot: { mime: "image/png", data: await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: n, g: 80, b: 120 } } }).png().toBuffer() }, ip: `203.0.113.${n}`, userAgent: "test" });
  process.env.FEISHU_INTERNAL_ENABLED = "true";
  const [row] = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  return { id, file: path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice("local:".length)) };
}
const state = async (id: number) =>
  (await sql<{ forwarded: boolean; forward_error: string | null; screenshot_key: string | null }[]>`
    SELECT forwarded_at IS NOT NULL AS forwarded, forward_error, screenshot_key FROM feedback WHERE id = ${id}`)[0]!;
const sentFor = (id: number) => feishu.sent.find((m) => m.title === `反馈 #${id}`);
const olderBy = (id: number, interval: string) => sql`UPDATE feedback SET created_at = now() - ${interval}::interval WHERE id = ${id}`;

test("a failed screenshot upload keeps the feedback waiting, and the sweep sends it with the image", async () => {
  const { id, file } = await submit();
  assert.equal((await state(id)).forward_error, "pending");
  feishu.uploadFails = true;
  await assert.rejects(forwardFeedbackToFeishu(id));
  const waiting = await state(id);
  assert.deepEqual([waiting.forwarded, waiting.forward_error], [false, "feishu upload: upload broken"], "the reason is kept for the admin");
  assert.ok(existsSync(file) && !sentFor(id), "nothing is sent without the screenshot yet");

  feishu.uploadFails = false;
  await olderBy(id, "10 minutes");
  await forwardPendingFeedback();
  assert.deepEqual({ ...(await state(id)) }, { forwarded: true, forward_error: null, screenshot_key: `feishu:img_${T}` });
  assert.ok(sentFor(id)?.content.some((p) => JSON.stringify(p).includes(`img_${T}`)), "the message carries the image");
  assert.ok(!existsSync(file), "the local file is gone once uploaded");
});

test("a send that fails after the upload goes out with the same image next time", async () => {
  const { id, file } = await submit();
  feishu.sendFails = true;
  await assert.rejects(forwardFeedbackToFeishu(id));
  assert.equal((await state(id)).screenshot_key, `feishu:img_${T}`);
  assert.ok(!existsSync(file));
  feishu.sendFails = false;
  assert.equal(await forwardFeedbackToFeishu(id), "sent");
  assert.ok(sentFor(id)?.content.some((p) => JSON.stringify(p).includes(`img_${T}`)), "the uploaded image is not lost");
});

test("a screenshot that cannot be uploaded for a day is dropped, and the text still goes", async () => {
  const { id, file } = await submit();
  feishu.uploadFails = true;
  await olderBy(id, "25 hours");
  assert.equal(await forwardFeedbackToFeishu(id), "sent");
  feishu.uploadFails = false;
  assert.deepEqual({ ...(await state(id)) }, { forwarded: true, forward_error: null, screenshot_key: "gone:upload" });
  assert.ok(!existsSync(file), "no copy of the screenshot is kept");
  assert.ok(JSON.stringify(sentFor(id)?.content).includes("截图未能上传"), "the chat is told the screenshot is missing");
});

test("a picture Feishu refuses is dropped at once, and the text still goes", async () => {
  const { id, file } = await submit();
  feishu.uploadRefused = true;
  const uploads = feishu.uploads;
  assert.equal(await forwardFeedbackToFeishu(id), "sent");
  feishu.uploadRefused = false;
  assert.equal(feishu.uploads, uploads + 1, "offered once, not again on every sweep");
  assert.deepEqual({ ...(await state(id)) }, { forwarded: true, forward_error: null, screenshot_key: "gone:upload" });
  assert.ok(!existsSync(file));
});

test("screenshots left behind are removed after a week, whether or not forwarding ran; without the chat they stay", async () => {
  const dir = path.join(config.dataDir, "feedback-screenshots");
  mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, `stale-${T}.png`);
  const recent = path.join(dir, `recent-${T}.png`);
  writeFileSync(stale, "x");
  writeFileSync(recent, "x");
  const nineDaysAgo = new Date(Date.now() - 9 * 86400_000);
  utimesSync(stale, nineDaysAgo, nineDaysAgo);
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  assert.equal((await dailyRetention()).deletedScreenshots, 0);
  assert.ok(existsSync(stale), "a screenshot nobody forwards is the only copy");
  process.env.FEISHU_INTERNAL_ENABLED = "true";
  const result = await dailyRetention();
  assert.ok(result.deletedScreenshots >= 1);
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(recent), "a screenshot still waiting for forwarding stays");
});

test("imported feedback that was never forwarded is not sent now", async () => {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO feedback (content, source_hash, created_at) VALUES (${`旧反馈 ${T}`}, ${`imported:${T}`}, now() - interval '10 minutes') RETURNING id`;
  await forwardPendingFeedback();
  assert.equal((await state(row!.id)).forwarded, false);
  assert.equal(sentFor(row!.id), undefined);
});

test("a browser retry creates one feedback and forwards one notification", async () => {
  process.env.FEISHU_INTERNAL_ENABLED = "true";
  const input = { ip: "203.0.113.190", userAgent: "Firefox", content: `重试的安全报告 ${T}: <script>alert(1)</script>` };
  const results = await Promise.all(Array.from({ length: 4 }, () => submitFeedback(input)));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  const id = results[0]!.id;
  for (let i = 0; i < 100 && !(await state(id)).forwarded; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok((await state(id)).forwarded);
  assert.equal(feishu.sent.filter(m => m.title === `反馈 #${id}`).length, 1);
  assert.ok(JSON.stringify(sentFor(id)?.content).includes(input.content));
});

test("a report the model reads as empty is marked spam and not pushed; a real one, or a model that cannot answer, still goes out", async () => {
  pointModels(MODEL_URL, ["qwen3.7-flash"]);
  config.modelCallsEnabled = true;
  try {
    const pending = async (content: string, screenshot = false) => {
      delete process.env.FEISHU_INTERNAL_ENABLED;
      const { id } = await submitFeedback({ content: `${content} ${T}`, ip: `198.51.100.${100 + ++n}`, userAgent: "Firefox", ...(screenshot ? { screenshot: { mime: "image/png", data: await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: n, g: 1, b: 1 } } }).png().toBuffer() } } : {}) });
      process.env.FEISHU_INTERNAL_ENABLED = "true";
      await olderBy(id, "10 minutes");
      return id;
    };
    const record = async (id: number) => (await sql<{ status: string; kind: string | null; note: string | null; forward_error: string | null }[]>`SELECT status, kind, note, forward_error FROM feedback WHERE id = ${id}`)[0]!;

    model.noise = true;
    const empty = await pending("111111");
    await forwardPendingFeedback();
    assert.equal(sentFor(empty), undefined);
    const dropped = await record(empty);
    assert.deepEqual([dropped.status, dropped.kind, dropped.forward_error], ["spam", "other", null]);
    assert.match(dropped.note!, /模型/, "the record says why nobody was told");
    const [logged] = await sql<{ actor: string }[]>`SELECT actor FROM audit_log WHERE subject = ${`feedback:${empty}`} AND action = 'feedback.update'`;
    assert.equal(logged?.actor, "feedback-auto");
    const calls = model.calls;
    await forwardPendingFeedback();
    assert.equal(model.calls, calls, "settled: not read again on the next sweep");

    const handled = await pending("已经有人处理了的反馈");
    await sql`UPDATE feedback SET status = 'triaged' WHERE id = ${handled}`;
    await forwardPendingFeedback();
    assert.ok(sentFor(handled), "only a report nobody has looked at yet can be dropped");
    assert.equal((await record(handled)).status, "triaged");

    model.noise = false;
    const real = await pending("搜索打不开");
    await forwardPendingFeedback();
    assert.ok(sentFor(real));
    assert.equal((await record(real)).status, "new");

    model.fails = true;
    const down = await pending("模型挂了的时候提的反馈");
    await forwardPendingFeedback();
    assert.ok(sentFor(down), "a model that cannot answer does not hold the report back");
    assert.equal((await record(down)).status, "new");
    model.fails = false;

    const asked: string[] = [];
    const before = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith(MODEL_URL)) asked.push(JSON.parse(String(init?.body)).messages.at(-1).content);
      return before(input, init);
    }) as typeof fetch;
    const shot = await pending("这里不对", true);
    await forwardPendingFeedback();
    globalThis.fetch = before;
    assert.ok(sentFor(shot));
    assert.ok(asked.some((text) => text.includes("这里不对") && text.includes('"has_screenshot":true')), "the model knows a picture came with the words");
  } finally {
    config.modelCallsEnabled = false;
  }
});

test("a report from a page a module takes itself stays out of the chat; its screenshot still goes to Feishu and is read back from there", async () => {
  installModules([defineServerModule({ name: "deals", feedbackPages: ["/deals"] })]);
  try {
    const from = async (pageUrl: string) => {
      delete process.env.FEISHU_INTERNAL_ENABLED;
      const shot = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: ++n, g: 200, b: 9 } } }).jpeg().toBuffer();
      const { id } = await submitFeedback({ content: `从页面提的反馈 ${T}-${n}`, pageUrl, screenshot: { mime: "image/jpeg", data: shot }, ip: `198.51.100.${n}`, userAgent: "Firefox" });
      process.env.FEISHU_INTERNAL_ENABLED = "true";
      await olderBy(id, "10 minutes");
      const [row] = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
      return { id, file: path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice("local:".length)) };
    };
    const read = async (id: number) => {
      const png = await readFeedbackScreenshot(id);
      return png && { type: sniffImageType(png), width: (await sharp(png).metadata()).width };
    };

    feishu.uploadFails = true;
    const taken = await from(`${config.siteUrl}/deals?tab=daily`);
    await forwardPendingFeedback();
    assert.ok((await state(taken.id)).forward_error, "the screenshot still waits for Feishu");
    assert.deepEqual(await read(taken.id), { type: "image/png", width: 4 }, "read from the file while it waits here");
    feishu.uploadFails = false;

    const elsewhere = await from(`${config.siteUrl}/deals/more`);
    await forwardPendingFeedback();
    assert.equal(sentFor(taken.id), undefined, "the owner's chat is not told");
    assert.deepEqual(await state(taken.id), { forwarded: false, forward_error: null, screenshot_key: `feishu:img_${T}` });
    assert.equal(existsSync(taken.file), false, "only the Feishu image key is kept");
    assert.deepEqual(await read(taken.id), { type: "image/png", width: 4 }, "read back from Feishu by its key");
    assert.ok(sentFor(elsewhere.id), "another page's report goes to the chat as before");

    const [sent, uploads] = [feishu.sent.length, feishu.uploads];
    await forwardPendingFeedback();
    assert.deepEqual([feishu.sent.length, feishu.uploads], [sent, uploads], "settled: the sweep leaves it alone");

    const { id: plain } = await submitFeedback({ content: `没带截图的反馈 ${T}`, ip: "198.51.100.250", userAgent: "Firefox" });
    assert.equal(await readFeedbackScreenshot(plain), null);
  } finally {
    installModules([]);
  }
});

/** Handles one feedback as the admin would: against the version it was read at. */
async function handle(id: number, change: { status?: string; kind?: string | null; idea?: string | null; note?: string | null }) {
  const [row] = (await listFeedback({ id })).rows;
  return updateFeedback(id, { ...change, version: new Date(row!.updated_at).toISOString() }, "test");
}
const ask = (content: string, ip: string) => {
  delete process.env.FEISHU_INTERNAL_ENABLED;
  return submitFeedback({ content: `${content} ${T}`, ip, userAgent: "Firefox" });
};

test("handling records what each feedback is, and suggestions for the same idea add up by sender", async () => {
  const idea = `GitHub 热点项目榜 ${T}`;
  const first = await ask("想要一个 GitHub 热门项目榜", "198.51.100.11");
  const second = await ask("能不能加 GitHub trending", "198.51.100.12");
  const again = await ask("还是想要 GitHub 热点", "198.51.100.11");
  const spam = await ask("GitHub 热点 GitHub 热点", "198.51.100.13");
  const english = await ask("加一个英文版", "198.51.100.14");
  await handle(first.id, { kind: "suggestion", idea, status: "triaged" });
  await handle(second.id, { kind: "suggestion", idea: `  ${idea} `, status: "triaged" });
  await handle(again.id, { kind: "suggestion", idea, status: "triaged" });
  await handle(spam.id, { kind: "suggestion", idea, status: "spam" });
  await handle(english.id, { kind: "suggestion", idea: `英文版 ${T}`, status: "triaged" });

  const pool = (await listFeedback({ kind: "suggestion" })).ideas.filter((i) => i.idea.endsWith(T));
  assert.deepEqual(pool.map((i) => [i.idea, i.people]), [[idea, 2], [`英文版 ${T}`, 1]],
    "the sender who asked twice counts once, spam does not count, the most asked comes first");
  const listed = await listFeedback({ kind: "suggestion", idea });
  assert.deepEqual(listed.rows.map((r) => r.id).sort(), [first.id, second.id, again.id, spam.id].sort());
  assert.ok(listed.rows.every((r) => r.kind === "suggestion" && r.idea === idea), "the name is kept without surrounding spaces");
  assert.ok((listed.kinds.suggestion ?? 0) >= 5);
  const [audit] = await sql<{ before: { kind: string | null }; after: { kind: string; idea: string } }[]>`
    SELECT before, "after" FROM audit_log WHERE subject = ${`feedback:${first.id}`} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([audit!.before.kind, audit!.after.kind, audit!.after.idea], [null, "suggestion", idea]);
});

test("the pool lists every idea, however many there are", async () => {
  const named = Array.from({ length: 201 }, (_, i) => `建议池第 ${i + 1} 项 ${T}`);
  await sql`INSERT INTO feedback ${sql(named.map((idea, i) => ({ content: `想要${idea}`, source_hash: `pool:${T}:${i}`, status: "triaged", kind: "suggestion", idea })))}`;
  const pool = new Set((await listFeedback({ kind: "suggestion" })).ideas.map((i) => i.idea));
  assert.deepEqual(named.filter((idea) => !pool.has(idea)), []);
});

test("an unknown kind, an idea outside a suggestion and a stale version are refused; reclassifying leaves the pool", async () => {
  const { id } = await ask("为什么模型榜上没有千问了", "198.51.100.21");
  await assert.rejects(handle(id, { kind: "praise" }), /unknown kind/);
  await assert.rejects(handle(id, { kind: "question", idea: "千问上榜" }), /只有建议/);
  await assert.rejects(handle(id, { kind: "suggestion", idea: "名".repeat(41) }), /40/);
  const stale = new Date((await listFeedback({ id })).rows[0]!.updated_at).toISOString();
  await handle(id, { kind: "suggestion", idea: `千问上榜 ${T}` });
  await assert.rejects(updateFeedback(id, { kind: "question", version: stale }, "test"), (e) => e instanceof Conflict);
  await handle(id, { kind: "question" });
  const [row] = (await listFeedback({ id })).rows;
  assert.deepEqual([row!.kind, row!.idea], ["question", null], "a feedback that is no longer a suggestion leaves the pool");
  assert.ok(!(await listFeedback({ kind: "suggestion" })).ideas.some((i) => i.idea === `千问上榜 ${T}`));
});

test("the admin page filters by kind and idea and edits both through the API", async () => {
  const { buildApp } = await import("../apps/api/src/app.ts");
  const { registerAdmin } = await import("../apps/api/src/routes/admin.ts");
  const { ADMIN } = await import("@aihot/site");
  const { passwordLogin, SESSION_COOKIE } = await import("@aihot/backend/admin/auth");
  const app = await buildApp();
  // The engine's admin API, which a site without admin pages does not mount.
  if (!ADMIN) registerAdmin(app);
  const originalPassword = config.adminPassword;
  config.adminPassword = "feedback-handling-test-password";
  try {
    const { token } = await passwordLogin(config.adminPassword, "/admin", "test");
    const cookie = `${SESSION_COOKIE}=${token}`;
    const headers = { cookie, "x-csrf-token": (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })).json().csrf };
    const idea = `动态下面能评论 ${T}`;
    const { id } = await ask("想在每条动态下面评论", "198.51.100.31");
    const version = new Date((await listFeedback({ id })).rows[0]!.updated_at).toISOString();
    const edited = await app.inject({ method: "PATCH", url: `/api/admin/feedback/${id}`, headers, payload: { kind: "suggestion", idea, version } });
    assert.equal(edited.statusCode, 200, edited.body);
    const listed = await app.inject({ method: "GET", url: `/api/admin/feedback?kind=suggestion&idea=${encodeURIComponent(idea)}`, headers: { cookie } });
    assert.deepEqual(listed.json().rows.map((r: { id: number }) => r.id), [id]);
    assert.deepEqual(listed.json().ideas.find((i: { idea: string }) => i.idea === idea)?.people, 1);
    const bugs = await app.inject({ method: "GET", url: "/api/admin/feedback?kind=bug", headers: { cookie } });
    assert.ok(!bugs.json().rows.some((r: { id: number }) => r.id === id));
  } finally {
    config.adminPassword = originalPassword;
    await app.close();
  }
});
