// The admin cookie's Secure flag follows the request that set it, not the canonical SITE_URL: a site
// reachable over both HTTPS and a plain-HTTP LAN address must stay signed in on either entry.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { registerAdminAuth } from "../apps/api/src/routes/admin-auth.ts";

const T = tag();
const PASSWORD = `test-cookie-password-${T}`;
const original = { password: config.adminPassword, siteUrl: config.siteUrl, environment: config.environmentName };
// production sets trustProxy so req.protocol reads X-Forwarded-Proto from the reverse proxy.
const app = Fastify({ logger: false, trustProxy: true });
registerAdminAuth(app);
let base = "";

before(async () => {
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});
beforeEach(() => {
  config.adminPassword = PASSWORD;
  config.siteUrl = "https://example.test";
  config.environmentName = "development";
});
after(async () => {
  await app.close();
  config.adminPassword = original.password;
  config.siteUrl = original.siteUrl;
  config.environmentName = original.environment;
  await closeDb();
});

async function signIn(headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/auth/password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: `password=${encodeURIComponent(PASSWORD)}`,
    redirect: "manual",
  });
  const cookie = res.headers.getSetCookie().find((line) => line.startsWith("aihot_admin=")) ?? "";
  return { status: res.status, cookie };
}

test("a plain-HTTP entry keeps its session: the cookie is not Secure even when SITE_URL is https", async () => {
  const { status, cookie } = await signIn();
  assert.equal(status, 303);
  assert.match(cookie, /^aihot_admin=\S+;/);
  assert.doesNotMatch(cookie, /;\s*Secure\b/, "a browser drops a Secure cookie on a plain-HTTP page");
});

test("the HTTPS entry behind the proxy still gets a Secure cookie", async () => {
  const { status, cookie } = await signIn({ "x-forwarded-proto": "https" });
  assert.equal(status, 303);
  assert.match(cookie, /;\s*Secure\b/);
});

test("signing out follows the same scheme, so a plain-HTTP session can be cleared", async () => {
  const res = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "", redirect: "manual" });
  assert.equal(res.status, 303);
  const cookie = res.headers.getSetCookie().find((line) => line.startsWith("aihot_admin=")) ?? "";
  assert.match(cookie, /Max-Age=0/);
  assert.doesNotMatch(cookie, /;\s*Secure\b/);
});
