// Feedback reaches the internal Feishu chat with its screenshot even when Feishu fails at first: a
// failed upload or send is tried again, only the Feishu image key is kept, a screenshot that cannot be
// uploaded for a day, or that Feishu refuses outright, is dropped (the text still goes), and imported
// feedback is never forwarded again. Screenshots that were never forwarded stay on the server: with
// Feishu optional they are the only copy.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { forwardFeedbackToFeishu } from "@aihot/backend/notify/feishu";
import { forwardPendingFeedback, submitFeedback } from "@aihot/backend/operations/feedback";

const T = tag();
config.dataDir = mkdtempSync(path.join(tmpdir(), "aihot-feedback-"));
process.env.FEISHU_APP_ID = "test-app";
process.env.FEISHU_APP_SECRET = "test-secret";
process.env.FEISHU_INTERNAL_CHAT_ID = "oc_test";

// Feishu's message app, answered here: uploads and sends fail while the switches say so.
const feishu = { uploadFails: false, uploadRefused: false, uploads: 0, sendFails: false, sent: [] as Array<{ title: string; content: unknown[][] }> };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://open.feishu.cn/")) return realFetch(input, init);
  if (url.endsWith("/auth/v3/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "t", expire: 7200 });
  if (url.endsWith("/im/v1/images")) {
    feishu.uploads += 1;
    if (feishu.uploadRefused) return Response.json({ code: 234011, msg: "Can't regonise the image format." }, { status: 400 });
    return Response.json(feishu.uploadFails ? { code: 99, msg: "upload broken" } : { code: 0, data: { image_key: `img_${T}` } });
  }
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

test("imported feedback that was never forwarded is not sent now", async () => {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO feedback (content, source_hash, created_at) VALUES (${`旧反馈 ${T}`}, ${`imported:${T}`}, now() - interval '10 minutes') RETURNING id`;
  await forwardPendingFeedback();
  assert.equal((await state(row!.id)).forwarded, false);
  assert.equal(sentFor(row!.id), undefined);
});
