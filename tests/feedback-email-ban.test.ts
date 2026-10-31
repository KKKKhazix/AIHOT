import "./setup.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { FeedbackRejected, submitFeedback } from "@aihot/backend/operations/feedback";
import { banFeedbackEmail, listFeedback, unbanSource } from "@aihot/backend/admin/feedback";

process.env.FEISHU_INTERNAL_ENABLED = "false";
after(closeDb);

test("a confirmed email ban holds after changing network and browser, before image decoding", async () => {
  const email = "confirmed-abuse@example.com";
  const key = "email:" + createHmac("sha256", process.env.SESSION_SECRET!).update(email).digest("base64url");
  await sql`INSERT INTO feedback_bans (source_hash, reason, created_by, expires_at)
    VALUES (${key}, 'confirmed repeated abuse', 'test', now() + interval '48 hours')`;
  const input = { content: "same incident after a source change", email: "  CONFIRMED-ABUSE@EXAMPLE.COM  ", ip: "203.0.113.230", userAgent: "Firefox", screenshot: { mime: "image/png", data: Buffer.from("invalid image") } };
  await assert.rejects(submitFeedback({ ...input, screenshot: undefined }), e => e instanceof FeedbackRejected && e.status === 429 && e.retryAfter! > 172000);
  await assert.rejects(submitFeedback({ ...input, ip: "203.0.113.231", userAgent: "Chrome" }), e => e instanceof FeedbackRejected && e.status === 429);
  assert.equal((await sql`SELECT 1 FROM feedback WHERE content=${input.content}`).length, 0);
});

test("manual email moderation expires, is visible on every matching report, and can be released early", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const input = { ip: "203.0.113.232", userAgent: "Firefox", content: "confirmed incident", email: "moderated@example.com" };
  const first = await submitFeedback(input);
  const second = await submitFeedback({ ...input, ip: "203.0.113.233", email: "MODERATED@example.com" });
  const ban = await banFeedbackEmail(first.id, "confirmed repeated abuse", "test");
  assert.equal(ban.expiresAt.getTime() - Date.now(), 48 * 3600_000);
  const admin = await listFeedback({ q: "moderated@example.com" });
  assert.deepEqual(new Set(admin.rows.map(r => r.id)), new Set([first.id, second.id]));
  assert.ok(admin.rows.every(r => r.email_banned && !r.banned));
  const [audit] = await sql`SELECT subject, reason, "after" FROM audit_log WHERE subject=${`feedback-source:${ban.key}`} ORDER BY id DESC LIMIT 1`;
  assert.ok(!JSON.stringify(audit).includes(input.email), "no raw email is copied to the ban audit");
  await assert.rejects(submitFeedback({ ...input, ip: "203.0.113.234" }), e => e instanceof FeedbackRejected && e.status === 429);
  await unbanSource(ban.key, "test");
  assert.ok((await listFeedback({ q: input.email })).rows.every(r => !r.email_banned));
  assert.ok((await submitFeedback({ ...input, ip: "203.0.113.234" })).id);
  await banFeedbackEmail(first.id, "confirmed repeated abuse", "test");
  t.mock.timers.tick(48 * 3600_000 + 1);
  assert.ok((await submitFeedback({ ...input, ip: "203.0.113.235" })).id, "expiry restores submission without a housekeeping run");
  assert.equal((await sql`SELECT 1 FROM feedback_bans WHERE source_hash=${ban.key}`).length, 0);
});

test("email moderation does not block shared domains, anonymous security reports, or turn forged contacts into automatic bans", async () => {
  const base = { ip: "203.0.113.236", userAgent: "Firefox", content: "漏洞报告 <script>alert(1)</script> http://127.0.0.1/" };
  const accepted = await submitFeedback({ ...base, email: "other-reader@example.com" });
  assert.ok(accepted.id);
  assert.ok((await submitFeedback({ ...base, content: base.content + " anonymous" })).id);
  await assert.rejects(banFeedbackEmail((await submitFeedback({ ...base, content: "no contact" })).id, "reason", "test"), /没有可封禁的邮箱/);
  const forged = { ...base, ip: "203.0.113.237", email: "victim@example.com" };
  for (let i = 0; i < 20; i++) await submitFeedback(forged);
  await assert.rejects(submitFeedback(forged), e => e instanceof FeedbackRejected && e.status === 429);
  assert.ok((await submitFeedback({ ...forged, ip: "203.0.113.238", content: "the real reader's security report" })).id);
});

test("the authenticated moderation API enforces the pause on multipart submissions for both hosts", async () => {
  const { buildApp } = await import("../apps/api/src/app.ts");
  const { registerAdmin } = await import("../apps/api/src/routes/admin.ts");
  const { ADMIN } = await import("@aihot/site");
  const { config } = await import("@aihot/backend/config");
  const { passwordLogin, SESSION_COOKIE } = await import("@aihot/backend/admin/auth");
  const app = await buildApp();
  // The engine's admin API, which a site without admin pages does not mount.
  if (!ADMIN) registerAdmin(app);
  const originalPassword = config.adminPassword;
  config.adminPassword = "feedback-moderation-test-password";
  try {
    const input = { content: "confirmed multipart abuse", email: "multipart-abuse@example.com", ip: "203.0.113.239", userAgent: "Firefox" };
    const { id } = await submitFeedback(input);
    const payload = { feedbackId: id, reason: "confirmed repeated abuse" };
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/feedback-bans", payload })).statusCode, 401);
    const { token } = await passwordLogin(config.adminPassword, "/admin", "test");
    const cookie = `${SESSION_COOKIE}=${token}`;
    const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } });
    const headers = { cookie, "x-csrf-token": me.json().csrf };
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/feedback-bans", headers: { cookie }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/feedback-bans", headers, payload })).statusCode, 204);
    const form = new FormData();
    form.set("email", input.email.toUpperCase());
    form.set("content", "changing network and browser");
    const request = new Request("http://local/api/site/feedback", { method: "POST", body: form });
    const multipart = Buffer.from(await request.arrayBuffer());
    for (const host of ["primary.example", "compatible.example"]) {
      const response = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { host, "content-type": request.headers.get("content-type")!, "x-real-ip": "203.0.113.240", "user-agent": "Chrome" }, payload: multipart });
      assert.equal(response.statusCode, 429, response.body);
      assert.equal(response.json().code, "rate_limited");
      assert.ok(Number(response.headers["retry-after"]) > 172000);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.equal((await sql`SELECT 1 FROM feedback WHERE lower(email)=${input.email}`).length, 1);
    const { feedbackEmailKey } = await import("@aihot/backend/operations/feedback");
    const released = await app.inject({ method: "DELETE", url: `/api/admin/feedback-bans/${encodeURIComponent(feedbackEmailKey(input.email))}`, headers: { ...headers, "content-type": "application/json" }, payload: {} });
    assert.equal(released.statusCode, 204, released.body);
    assert.ok((await submitFeedback({ ...input, ip: "203.0.113.240" })).id);
  } finally {
    config.adminPassword = originalPassword;
    await app.close();
  }
});
