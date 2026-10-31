// Repeated or flooding submissions are paused for a while; real corrections and changed reports stay
// separate feedback. A browser retry creating one feedback is tested with its notification (feedback.test).
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { submitFeedback } from "@aihot/backend/operations/feedback";

process.env.FEISHU_INTERNAL_ENABLED = "false";
after(closeDb);

test("normal corrections and security reports retain code, changed contacts, pages and images", async () => {
  const { default: sharp } = await import("sharp");
  const base = { ip: "203.0.113.181", userAgent: "Firefox", content: "漏洞报告\n<script>alert(1)</script>\nSELECT * FROM users;\nhttp://127.0.0.1/\n  缩进必须保留" };
  const screenshot = { mime: "image/png", data: await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer() };
  for (const [i, change] of [{ content: base.content + "\n补充复现条件" }, { email: "reporter@example.com" }, { pageUrl: "/feedback" }, { screenshot }].entries()) {
    const input = { ...base, ip: `203.0.113.${140 + i}` };
    const original = await submitFeedback(input);
    const changed = await submitFeedback({ ...input, ...change });
    assert.notEqual(changed.id, original.id);
    const [row] = await sql`SELECT content FROM feedback WHERE id=${original.id}`;
    assert.equal(row!.content, base.content);
  }
});

test("the page a report came from is kept only as a web address or a site path; the report itself is kept either way", async () => {
  const pages: Array<[string, string | null]> = [
    ["https://news.example/items/abc", "https://news.example/items/abc"], ["/leaderboard?from=feedback", "/leaderboard?from=feedback"],
    ["javascript:alert(document.domain)", null], [" JavaScript:alert(1)", null], ["data:text/html,<script>alert(1)</script>", null],
    ["//evil.example/x", null], ["mailto:someone@example.com", null], ["not a page", null],
  ];
  for (const [i, [pageUrl, kept]] of pages.entries()) {
    const { id } = await submitFeedback({ ip: `203.0.113.${150 + i}`, userAgent: "Firefox", content: `页面字段 ${i}`, pageUrl });
    const [row] = await sql`SELECT page_url FROM feedback WHERE id=${id}`;
    assert.equal(row!.page_url, kept, pageUrl);
  }
});

test("persistent repeat abuse is paused once, survives a new process, and never extends its expiry", async () => {
  const { feedbackSourceHash, FeedbackRejected } = await import("@aihot/backend/operations/feedback");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const input = { ip: "203.0.113.182", userAgent: "Firefox", content: "重复提交回归用例" };
  const first = await submitFeedback(input);
  for (let i = 1; i < 20; i++) assert.equal((await submitFeedback(input)).id, first.id);
  const code = `const {submitFeedback}=await import('@aihot/backend/operations/feedback');const {closeDb}=await import('@aihot/backend/db');try{await submitFeedback(${JSON.stringify(input)});console.log('unexpected accepted')}catch(e){console.log(JSON.stringify({status:e.status,retryAfter:e.retryAfter}))}finally{await closeDb()}`;
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, FEISHU_INTERNAL_ENABLED: "false" } });
  assert.deepEqual(JSON.parse(child.stdout.trim()), { status: 429, retryAfter: 3600 });
  const source = feedbackSourceHash(input.ip, input.userAgent);
  const [before] = await sql`SELECT expires_at FROM feedback_bans WHERE source_hash=${source}`;
  await assert.rejects(submitFeedback(input), e => e instanceof FeedbackRejected && e.status === 429 && e.retryAfter! > 3500);
  const [after] = await sql`SELECT expires_at FROM feedback_bans WHERE source_hash=${source}`;
  assert.equal(after!.expires_at.toISOString(), before!.expires_at.toISOString());
  const [counts] = await sql`SELECT (SELECT count(*)::int FROM feedback WHERE source_hash=${source}) AS saved,
    (SELECT count(*)::int FROM audit_log WHERE action='feedback.ban' AND subject=${`feedback-source:${source}`}) AS bans`;
  assert.deepEqual({ ...counts }, { saved: 1, bans: 1 });
});

test("slow changing feedback is paused for an hour; expiry restores it and other browser sources stay open", async t => {
  const { feedbackSourceHash, FeedbackRejected } = await import("@aihot/backend/operations/feedback");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const input = { ip: "203.0.113.183", userAgent: "Firefox", content: "" };
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await submitFeedback({ ...input, content: `持续提交 ${i}` })).id);
    t.mock.timers.tick(4 * 60_000);
  }
  assert.equal((await submitFeedback({ ...input, content: "持续提交 0" })).id, ids[0]);
  await assert.rejects(submitFeedback({ ...input, content: "持续提交 4" }), e => e instanceof FeedbackRejected && e.status === 429 && e.retryAfter === 3600);
  // Do not ban a whole shared network when one browser source abuses the feedback form.
  await submitFeedback({ ...input, userAgent: "Chrome", content: "同一共享网络的正常反馈" });
  t.mock.timers.tick(3600_000 + 1);
  const restored = await submitFeedback({ ...input, content: "到期后正常报告" });
  assert.ok(restored.id);
  const source = feedbackSourceHash(input.ip, input.userAgent);
  assert.equal((await sql`SELECT 1 FROM feedback_bans WHERE source_hash=${source}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='feedback.unban' AND subject=${`feedback-source:${source}`}`).length, 1);
});

test("a rapid fourth report is not saved, repeated requests do not extend the pause, and a moderator can release immediately", async () => {
  const { feedbackSourceHash, FeedbackRejected } = await import("@aihot/backend/operations/feedback");
  const { unbanSource, listFeedback, banSource } = await import("@aihot/backend/admin/feedback");
  const input = { ip: "203.0.113.184", userAgent: "Firefox", content: "" };
  for (let i = 0; i < 3; i++) await submitFeedback({ ...input, content: `不同报告 ${i}` });
  await assert.rejects(submitFeedback({ ...input, content: "第四条报告" }), e => e instanceof FeedbackRejected && e.status === 429 && e.retryAfter === 3600);
  const source = feedbackSourceHash(input.ip, input.userAgent);
  assert.equal((await sql`SELECT count(*)::int AS n FROM feedback WHERE source_hash=${source}`)[0]!.n, 3);
  const [before] = await sql`SELECT expires_at FROM feedback_bans WHERE source_hash=${source}`;
  await assert.rejects(submitFeedback({ ...input, content: "持续快速提交" }), e => e instanceof FeedbackRejected && e.status === 429);
  const [after] = await sql`SELECT expires_at FROM feedback_bans WHERE source_hash=${source}`;
  assert.equal(after!.expires_at.toISOString(), before!.expires_at.toISOString());
  const admin = await listFeedback({});
  assert.ok(admin.bans.find(b => b.source_hash === source)?.expires_at);
  assert.ok(admin.rows.filter(r => r.source_hash === source).every(r => r.banned));
  await unbanSource(source, "test");
  await submitFeedback({ ...input, content: "解除后可立即提交" });
  await banSource(source, "manual", "test");
  await assert.rejects(submitFeedback({ ...input, content: "人工封禁仍生效" }), e => e instanceof FeedbackRejected && e.status === 403);
});

test("daily cleanup removes expired temporary state and bans, preserves manual bans, and the admin hides expired entries", async () => {
  const { dailyRetention } = await import("@aihot/backend/operations/retention");
  const { listFeedback } = await import("@aihot/backend/admin/feedback");
  await sql`INSERT INTO feedback_bans (source_hash, reason, created_by, expires_at) VALUES ('expired-test','temporary','feedback-auto',now()-interval '1 second'), ('manual-test','manual','test',null)`;
  await sql`INSERT INTO feedback_submission_state (source_hash, expires_at) VALUES ('expired-test',now()-interval '1 second')`;
  assert.ok(!(await listFeedback({})).bans.some(b => b.source_hash === "expired-test"));
  const result = await dailyRetention();
  assert.ok(result.expiredFeedbackBans >= 1);
  assert.ok(result.expiredFeedbackState >= 1);
  assert.equal((await sql`SELECT 1 FROM feedback_bans WHERE source_hash='manual-test'`).length, 1);
});

test("rotating UA families cannot multiply one network's hourly feedback allowance", async t => {
  const { FeedbackRejected } = await import('@aihot/backend/operations/feedback');
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const families=['Chrome','Safari','Firefox','Edg','MicroMessenger','Mobile','Android','iPhone','iPad','Windows'];
  const ip='203.0.113.190';
  const results=await Promise.allSettled(Array.from({length:47},(_,i)=>submitFeedback({ip,userAgent:`${families[i%10]} ${families[Math.floor(i/10)]}`,content:`轮换来源测试 ${i}`})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,20,'the proposed shared-network budget caps attempts independently of UA');
  for(const r of results)if(r.status==='rejected')assert.ok(r.reason instanceof FeedbackRejected && r.reason.status===429);
  assert.ok((await submitFeedback({ip:'203.0.113.191',userAgent:'Firefox',content:'其他网络仍可正常反馈'})).id);
  t.mock.timers.tick(3600_001);
  assert.ok((await submitFeedback({ip,userAgent:'Chrome',content:'滚动窗口到期后恢复'})).id);
});

test("retries consume the shared network budget without saving duplicate feedback", async () => {
  const {FeedbackRejected}=await import('@aihot/backend/operations/feedback');
  const ip='203.0.113.192';
  const input={ip,userAgent:'Firefox',content:'相同请求重试不应重复保存'};
  const first=await submitFeedback(input);
  for(let i=1;i<20;i++) assert.equal((await submitFeedback(input)).id,first.id);
  await assert.rejects(submitFeedback({...input,userAgent:'Chrome',content:'换浏览器仍共享已用完的额度'}),e => e instanceof FeedbackRejected && e.status===429 && e.retryAfter!>0 && e.retryAfter!<=3600);
  assert.equal(Number((await sql`SELECT count(*) AS n FROM feedback WHERE content=${input.content}`)[0]!.n),1);
});
