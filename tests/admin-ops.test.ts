// Operations that must act on what they were meant for: releasing an unknown receipt of any analysis
// step puts its article back into processing; a selected card is not sent again to a group that
// already got another report of the same fact.
import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { pushSelected } from "@aihot/backend/notify/selected";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const SOURCE = `test-ops-${T}`;
const savedEnv: Array<[string, string | undefined]> = [];
const stubs: Array<{ close: () => Promise<void> }> = [];
// config is a module-load snapshot: mutating it (not process.env) is what the running code sees.
const savedConfigValve = config.dingtalkContentPushEnabled;
const setEnv = (key: string, value: string) => {
  savedEnv.push([key, process.env[key]]);
  process.env[key] = value;
};
after(async () => {
  config.dingtalkContentPushEnabled = savedConfigValve;
  for (const [key, value] of savedEnv.reverse()) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const stub of stubs.reverse()) await stub.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
async function article(selected = false) {
  n += 1;
  if (n === 1) await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Ops', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/ops-${T}-${n}`, title: `Ops ${n} ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  if (selected) {
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
              VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`摘要${n}-${T}`}, 90, true)`;
  }
  return articleId;
}

test("releasing an unknown receipt of an analysis step puts the article back", async () => {
  const id = await article();
  await sql`UPDATE articles SET processing_state = 'failed', processing_error = 'receipt outcome unknown' WHERE id = ${id}`;
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, subject, status) VALUES (${`test-${T}`}, 'glm', 'score_article', ${`article:${id}@1`}, 'unknown') RETURNING id`;
  const out = await releaseReceipt(r!.id, { billed: false, note: "checked" }, "test");
  assert.equal(out?.requeued, true);
  const [a] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${id}`;
  assert.notEqual(a!.processing_state, "failed");
});

test("a report grouped into a fact already sent to a group is not sent there again", async () => {
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, note) VALUES (${`test-target-${T}`}, 'content', 'log', true, now() - interval '1 day', 'test')`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`ops-${T}`}, 'fact') RETURNING id`;
  const sent = await article(true);
  const later = await article(true);
  for (const id of [sent, later]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${id}`;
    await publishArticle(id);
  }
  // The first was sent to the group under an earlier fact's key.
  await sql`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status) VALUES (${`test-target-${T}`}, 'selected', ${sent}, ${`selected:fact:old-${T}`}, 'sent')`;
  await pushSelected(later);
  const rows = await sql`SELECT 1 FROM deliveries WHERE target_key = ${`test-target-${T}`} AND subject_id = ${later}`;
  assert.equal(rows.length, 0);
});

test("the content group gets first-party and near-first-party sources only", async () => {
  const media = `${SOURCE}-t2`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${media}, 'Media', 'rss', 'T2', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: media, url: `https://example.com/ops-t2-${T}`, title: `Ops T2 ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题T2-${T}`}, ${`摘要T2-${T}`}, 90, true)`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await publishArticle(articleId);
  assert.deepEqual(await pushSelected(articleId), { status: "skipped", reason: "not a first-party source" });
});

test("an enabled DingTalk target receives signed markdown", async () => {
  const secret = `SEC-${T}`;
  const bodies: Array<{ url: string; body: string }> = [];
  const dingtalk = await stub((_hit, req) => {
    bodies.push({ url: req.url, body: req.body });
    return { errcode: 0, errmsg: "ok" };
  });
  stubs.push(dingtalk);
  setEnv("FEISHU_CONTENT_PUSH_ENABLED", "false");
  setEnv("DINGTALK_CONTENT_PUSH_ENABLED", "true");
  config.dingtalkContentPushEnabled = true; // config is a load-time snapshot: the running code reads this
  setEnv("DINGTALK_PUSH_WEBHOOK_URL", `${dingtalk.url}/robot/send?access_token=tok-${T}`);
  setEnv("DINGTALK_PUSH_SECRET", secret);
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, config_ref, note)
            VALUES (${`test-dingtalk-${T}`}, 'content', 'dingtalk_webhook', true, now() - interval '1 day', 'DINGTALK_PUSH_WEBHOOK_URL', 'test')`;

  const id = await article(true);
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${id}`;
  await publishArticle(id);
  assert.equal((await pushSelected(id)).status, "pushed");

  assert.ok(bodies.length >= 1, "the webhook was called");
  const last = bodies[bodies.length - 1]!;
  const [pub] = await sql<{ title: string }[]>`SELECT title FROM publications WHERE article_id = ${id}`;
  const message = JSON.parse(last.body) as { msgtype: string; markdown: { title: string; text: string } };
  assert.equal(message.msgtype, "markdown");
  assert.equal(message.markdown.title, pub!.title);
  assert.ok(message.markdown.text.includes(pub!.title), "the title is in the text");
  assert.ok(message.markdown.text.includes("原文"), "the original link is in the text");
  // The signature: HMAC-SHA256 of "timestamp\nsecret", base64 — the robot's 加签 rule. searchParams
  // already decodes the URL-encoded sign the sender appends, so compare the raw base64.
  const url = new URL(last.url, "http://127.0.0.1");
  const timestamp = url.searchParams.get("timestamp")!;
  const sign = url.searchParams.get("sign")!;
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  assert.equal(sign, expected);
  await dingtalk.close();
});

test("a dingtalk target with its channel valve off records a skip and sends nothing", async () => {
  config.dingtalkContentPushEnabled = false;
  await sql`UPDATE notify_targets SET enabled = false WHERE key IN (${`test-dingtalk-${T}`}, ${`test-target-${T}`})`;
  const dingtalk = await stub(() => ({ errcode: 0 }));
  stubs.push(dingtalk);
  setEnv("DINGTALK_CONTENT_PUSH_ENABLED", "false");
  setEnv("DINGTALK_PUSH_WEBHOOK_URL", `${dingtalk.url}/robot/send?access_token=off-${T}`);
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, config_ref, note)
            VALUES (${`test-dingtalk-off-${T}`}, 'content', 'dingtalk_webhook', true, now() - interval '1 day', 'DINGTALK_PUSH_WEBHOOK_URL', 'test')`;
  const id = await article(true);
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${id}`;
  await publishArticle(id);
  const out = await pushSelected(id);
  assert.equal(out.status, "skipped");
  assert.deepEqual(out.targets?.map((t) => t.status), ["skipped"]);
  await dingtalk.close();
});

test("DingTalk markdown keeps an original link with brackets whole and dates like the Feishu card", async () => {
  const { dingtalkMarkdown } = await import("@aihot/backend/notify/dingtalk");
  const { text } = dingtalkMarkdown({
    title: "t", sourceName: "s", published: "11月7日发布", summary: null, reason: null, reasonLabel: "r",
    articleId: "a1", url: "https://en.wikipedia.org/wiki/Claude_(language_model) x",
  });
  assert.ok(text.includes("s · 11月7日发布"), text);
  assert.ok(text.includes("(https://en.wikipedia.org/wiki/Claude_%28language_model%29%20x)"), text);
});

test("a push with no DingTalk form records a skip at an enabled DingTalk target", async () => {
  config.dingtalkContentPushEnabled = true;
  const key = `test-dingtalk-cardonly-${T}`;
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, config_ref, note)
            VALUES (${key}, 'content', 'dingtalk_webhook', true, now() - interval '1 day', 'DINGTALK_PUSH_WEBHOOK_URL', 'test')`;
  const { deliverContent } = await import("@aihot/backend/notify/deliver");
  const out = await deliverContent({ subjectKind: "test", subjectId: `cardonly-${T}`, dedupeKey: `cardonly-${T}`, contentAt: new Date(), card: { any: 1 }, targetKey: key });
  assert.deepEqual(out, [{ target: key, status: "skipped" }]);
  config.dingtalkContentPushEnabled = false;
});
