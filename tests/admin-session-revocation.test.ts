import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
import { completeLogin, endSession, loginRedirect, passwordLogin, SESSION_COOKIE, sessionPrincipal } from "@aihot/backend/admin/auth";
import { adminHandler, registerAdminAuth } from "../apps/api/src/routes/admin-auth.ts";

const T = tag();
const PASSWORD_A = `test-password-a-${T}`;
const PASSWORD_B = `test-password-b-${T}`;
const SECRET_A = `test-session-secret-a-${T}`;
const SECRET_B = `test-session-secret-b-${T}`;
const APP = `test-login-app-${T}`;
const original = { password: config.adminPassword, unions: config.adminUnionIds, emails: config.adminEmails, dev: config.devAdmin, environment: config.environmentName };
const envKeys = ["SESSION_SECRET", "FEISHU_LOGIN_APP_ID", "FEISHU_LOGIN_APP_SECRET"];
const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
let profile: { union_id?: string; email?: string; enterprise_email?: string; name?: string } = {};
const oauth = await stub(async (_hit, req) => {
  if (req.url.endsWith("/token")) {
    const body = new URLSearchParams(req.body);
    assert.equal(body.get("client_id"), APP);
    assert.equal(body.get("client_secret"), "test-login-secret");
    return { access_token: "fictional-access-token" };
  }
  assert.ok(req.url.endsWith("/userinfo"));
  return profile;
});
const app = Fastify({ logger: false });
registerAdminAuth(app);
let writes = 0;
app.post("/api/admin/session-test", adminHandler(async () => ({ writes: ++writes })));
let base = "";
const realFetch = globalThis.fetch;
// OAuth 请求仅转发到本地假服务；测试之外的网络目的地一律拒绝。
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === base) return realFetch(input, init);
  assert.equal(url.origin, "https://passport.feishu.cn");
  return realFetch(`${oauth.url}${url.pathname}${url.search}`, init);
}) as typeof fetch;
const cookie = (token: string) => `${SESSION_COOKIE}=${token}`;
async function password(password = PASSWORD_A) {
  return (await passwordLogin(password, "/admin", "synthetic-agent")).token;
}
async function federated(claims = profile) {
  profile = claims;
  const redirect = loginRedirect("/admin");
  const state = new URL(redirect.url).searchParams.get("state")!;
  const login = await completeLogin("synthetic-code", state, redirect.stateCookie, "synthetic-agent");
  return login.token;
}
async function request(path: string, token: string, csrf?: string) {
  return realFetch(`${base}${path}`, { method: csrf === undefined ? "GET" : "POST",
    headers: { cookie: cookie(token), ...(csrf === undefined ? {} : { "x-csrf-token": csrf }) }, redirect: "manual" });
}
async function principal(token: string) {
  const response = await request("/api/admin/me", token);
  assert.equal(response.status, 200);
  return await response.json() as { csrf: string; dev: boolean; name: string };
}
async function revoked(token: string, csrf = "old-csrf") {
  const before = writes;
  assert.equal((await request("/api/auth/check", token)).status, 401);
  assert.equal((await request("/api/admin/me", token)).status, 401);
  assert.equal((await request("/api/admin/session-test", token, csrf)).status, 401);
  assert.equal(writes, before);
  assert.equal(await sessionPrincipal(cookie(token)), null);
}
async function exists(token: string) {
  return (await sql`SELECT 1 FROM admin_sessions WHERE id_hash=${sha256(token)}`).length > 0;
}

before(async () => {
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});
beforeEach(() => {
  config.adminPassword = PASSWORD_A;
  config.adminUnionIds = [];
  config.adminEmails = [];
  config.devAdmin = null;
  config.environmentName = "development";
  process.env.SESSION_SECRET = SECRET_A;
  process.env.FEISHU_LOGIN_APP_ID = APP;
  process.env.FEISHU_LOGIN_APP_SECRET = "test-login-secret";
  profile = {};
});
after(async () => {
  globalThis.fetch = realFetch;
  await app.close(); await oauth.close();
  config.adminPassword = original.password; config.adminUnionIds = original.unions; config.adminEmails = original.emails;
  config.devAdmin = original.dev; config.environmentName = original.environment;
  for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await closeDb();
});

test("effective password replacement revokes old cookies at actual read/write/check guards", async () => {
  const token = await password();
  const me = await principal(token);
  assert.equal((await request("/api/auth/check", token)).status, 204);
  assert.equal((await request("/api/admin/session-test", token, me.csrf)).status, 200);
  config.adminPassword = PASSWORD_B;
  const before = writes;
  assert.equal((await request("/api/admin/session-test", token, me.csrf)).status, 401, "the write guard itself observes credential revocation");
  assert.equal(writes, before);
  await revoked(token, me.csrf);
  assert.equal(await exists(token), false);
  const fresh = await password(PASSWORD_B);
  assert.equal((await request("/api/auth/check", fresh)).status, 204);
  await assert.rejects(passwordLogin(PASSWORD_A, "/admin", undefined));
  config.adminPassword = PASSWORD_A;
  await revoked(token, me.csrf);
});

for (const next of [null, "short"]) test(`password ${next === null ? "removal" : "invalid-short config"} revokes existing sessions`, async () => {
  const token = await password();
  config.adminPassword = next;
  await revoked(token);
  assert.equal(await exists(token), false);
});

test("unchanged sessions preserve CSRF, and neither the password nor the token is stored", async () => {
  const token = await password();
  const me = await principal(token);
  assert.equal((await principal(token)).csrf, me.csrf);
  assert.equal((await request("/api/admin/session-test", token, "wrong")).status, 403);
  assert.equal((await request("/api/admin/session-test", token, me.csrf)).status, 200);
  const rows = await sql`SELECT * FROM admin_sessions`;
  assert.ok(rows.length > 0 && !JSON.stringify(rows).includes(PASSWORD_A) && !JSON.stringify(rows).includes(token));
});

test("Feishu original union or normalized email remains authorized under OR semantics", async () => {
  const union = `union-or-${T}`; const email = `person-${T}@example.test`;
  config.adminUnionIds = [union]; config.adminEmails = [email];
  const token = await federated({ union_id: union, enterprise_email: email.toUpperCase(), email: "unused@example.test" });
  const before = oauth.hits();
  config.adminUnionIds = [];
  await principal(token);
  config.adminUnionIds = [union]; config.adminEmails = [];
  await principal(token);
  assert.equal(oauth.hits(), before, "session checks never contact the identity provider");
  config.adminUnionIds = [];
  await revoked(token);
  assert.equal(await exists(token), false);
  config.adminUnionIds = [union];
  await revoked(token);
});

test("a coalesced older profile email cannot keep a newly verified identity authorized", async () => {
  const union = `union-stale-${T}`; const oldEmail = `old-${T}@example.test`; const newEmail = `new-${T}@example.test`;
  const [user] = await sql<{ id: number }[]>`INSERT INTO admin_users(feishu_union_id,email) VALUES(${union},${oldEmail}) RETURNING id`;
  config.adminUnionIds = [union];
  const token = await federated({ union_id: union, email: newEmail });
  const [profileRow] = await sql<{ email: string }[]>`SELECT email FROM admin_users WHERE id=${user!.id}`;
  assert.equal(profileRow!.email, oldEmail);
  config.adminUnionIds = []; config.adminEmails = [oldEmail];
  await revoked(token);
});

test("new profile claims cannot replace the original verified session claims", async () => {
  const email = `original-${T}@example.test`; const replacement = `replacement-${T}@example.test`;
  config.adminEmails = [email];
  const token = await federated({ email });
  await sql`UPDATE admin_users SET email=${replacement} WHERE email=${email}`;
  config.adminEmails = [replacement];
  await revoked(token);
});

test("password and Feishu sessions sharing admin@local retain independent authority", async () => {
  const passwordToken = await password();
  config.adminEmails = ["admin@local"];
  const feishuToken = await federated({ union_id: `union-shared-${T}`, email: "admin@local" });
  const [pw] = await sql<{ user_id: number }[]>`SELECT user_id FROM admin_sessions WHERE id_hash=${sha256(passwordToken)}`;
  const [fs] = await sql<{ user_id: number }[]>`SELECT user_id FROM admin_sessions WHERE id_hash=${sha256(feishuToken)}`;
  assert.equal(pw!.user_id, fs!.user_id);
  config.adminPassword = PASSWORD_B;
  await revoked(passwordToken);
  await principal(feishuToken);
  const freshPassword = await password(PASSWORD_B);
  config.adminEmails = [];
  await revoked(feishuToken);
  await principal(freshPassword);
});

for (const change of ["app ID", "missing ID", "missing secret"]) test(`Feishu ${change} revokes only federated sessions`, async () => {
  const pw = await password();
  const email = `${change.replaceAll(" ", "-").toLowerCase()}-${T}@example.test`;
  config.adminEmails = [email];
  const fs = await federated({ email });
  if (change === "app ID") process.env.FEISHU_LOGIN_APP_ID = APP + "-replacement";
  if (change === "missing ID") delete process.env.FEISHU_LOGIN_APP_ID;
  if (change === "missing secret") delete process.env.FEISHU_LOGIN_APP_SECRET;
  await revoked(fs); await principal(pw);
});

test("Feishu app-secret-only rotation preserves same-app authorized sessions", async () => {
  const email = `secret-rotation-${T}@example.test`; config.adminEmails = [email];
  const token = await federated({ email });
  process.env.FEISHU_LOGIN_APP_SECRET = "test-replacement-secret";
  await principal(token);
});

for (const next of [SECRET_B, ""]) test(`session-secret ${next ? "rotation" : "removal"} revokes both methods`, async () => {
  const pw = await password();
  const email = `both-${next ? "rotate" : "remove"}-${T}@example.test`; config.adminEmails = [email];
  const fs = await federated({ email });
  process.env.SESSION_SECRET = next;
  await revoked(pw); await revoked(fs);
});

test("legacy unbound sessions fail closed and are deleted", async () => {
  const valid = await password();
  const [user] = await sql<{ user_id: number }[]>`SELECT user_id FROM admin_sessions WHERE id_hash=${sha256(valid)}`;
  const token = randomBytes(32).toString("base64url");
  await sql`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${user!.user_id},'legacy-csrf',now()+interval '1 day')`;
  await revoked(token, "legacy-csrf");
  assert.equal(await exists(token), false);
  await principal(valid);
});

test("malformed bindings and Feishu claims fail closed", async () => {
  for (const binding of [null, "not-a-binding", "0".repeat(64)]) {
    const token = await password();
    await sql`UPDATE admin_sessions SET auth_binding=${binding} WHERE id_hash=${sha256(token)}`;
    await revoked(token); assert.equal(await exists(token), false);
  }
  for (const claims of [null, {}, { appId: APP, unionId: 42, email: "admin@local" }, { appId: APP, unionId: null, email: [] }]) {
    config.adminEmails = ["admin@local"];
    const token = await federated({ email: "admin@local" });
    await sql`UPDATE admin_sessions SET auth_claims=${claims === null ? null : sql.json(claims as never)} WHERE id_hash=${sha256(token)}`;
    await revoked(token); assert.equal(await exists(token), false);
  }
});

test("expiry, unknown token, logout isolation and explicit development mode retain their guards", async () => {
  const one = await password(); const two = await password();
  await endSession(cookie(one)); await revoked(one); await principal(two);
  await sql`UPDATE admin_sessions SET expires_at=now()-interval '1 second' WHERE id_hash=${sha256(two)}`;
  await revoked(two); await revoked("unknown-test-token");
  config.devAdmin = { displayName: "Synthetic developer" };
  assert.equal((await sessionPrincipal(undefined))!.dev, true);
  assert.equal((await request("/api/auth/check", "unknown")).status, 401);
  config.environmentName = "production";
  assert.equal(await sessionPrincipal(undefined), null);
});
