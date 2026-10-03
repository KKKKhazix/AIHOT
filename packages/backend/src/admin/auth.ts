// Admin identity: the admin password (ADMIN_PASSWORD), or optionally Feishu OAuth with an allowlist of
// union_ids / emails; opaque sessions stored hashed, and an audit trail for every manual change.
// Development may impersonate an admin with DEV_AUTH_ROLE=admin; production refuses to start with it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { audit } from "../audit.ts";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

export const SESSION_COOKIE = "aihot_admin";
export const STATE_COOKIE = "aihot_oauth_state";
export const SESSION_DAYS = 30;
/** Register this callback in the Feishu open platform when Feishu sign-in is used. */
export const CALLBACK_URL = `${config.siteUrl}/api/auth/callback`;

/** Feishu sign-in is offered only when its app is configured. */
export function feishuLoginConfigured(): boolean {
  return !!credential("integrations", "FEISHU_LOGIN_APP_ID") && !!credential("integrations", "FEISHU_LOGIN_APP_SECRET");
}

export interface AdminPrincipal {
  userId: number | null;
  name: string;
  csrf: string;
  dev: boolean;
}

function secret(): string {
  const s = credential("auth", "SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

interface FeishuClaims {
  appId: string;
  unionId: string | null;
  email: string | null;
}

interface SessionAuth {
  method: "password" | "feishu";
  binding: string;
  claims: FeishuClaims | null;
}

function sessionBinding(method: SessionAuth["method"], identity: unknown, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify(["admin-session-v1", method, identity])).digest("hex");
}

function validClaims(value: unknown): value is FeishuClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return Object.keys(c).length === 3 && typeof c.appId === "string" && c.appId.length > 0 &&
    (c.unionId === null || (typeof c.unionId === "string" && c.unionId.length > 0)) &&
    (c.email === null || (typeof c.email === "string" && c.email.length > 0 && c.email === c.email.toLowerCase()));
}

function sessionAuthorized(row: { auth_method: string | null; auth_binding: string | null; auth_claims: unknown }): boolean {
  const key = credential("auth", "SESSION_SECRET");
  if (!key || !row.auth_binding || !/^[0-9a-f]{64}$/.test(row.auth_binding)) return false;
  let binding: string;
  if (row.auth_method === "password") {
    if (!config.adminPassword || config.adminPassword.length < 12 || row.auth_claims !== null) return false;
    binding = sessionBinding("password", config.adminPassword, key);
  } else if (row.auth_method === "feishu") {
    const c = row.auth_claims;
    if (!validClaims(c) || !feishuLoginConfigured() || c.appId !== credential("integrations", "FEISHU_LOGIN_APP_ID")) return false;
    if (!(c.unionId && config.adminUnionIds.includes(c.unionId)) && !(c.email && config.adminEmails.includes(c.email))) return false;
    // jsonb does not keep key order: rebuild the claims in their sign-in order, never from mutable profile data.
    binding = sessionBinding("feishu", { appId: c.appId, unionId: c.unionId, email: c.email }, key);
  } else return false;
  return timingSafeEqual(Buffer.from(binding, "hex"), Buffer.from(row.auth_binding, "hex"));
}

function sign(value: string): string {
  return `${value}.${createHmac("sha256", secret()).update(value).digest("base64url")}`;
}

function unsign(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value).slice(i + 1));
  const given = Buffer.from(signed.slice(i + 1));
  return expected.length === given.length && timingSafeEqual(expected, given) ? value : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Other cookies need not be URI-encoded. A malformed value must not break admin sign-in.
    }
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Where to send the browser to sign in; the signed state also carries where to return. */
export function loginRedirect(returnTo: string): { url: string; stateCookie: string } {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  if (!appId) throw new Error("FEISHU_LOGIN_APP_ID is not configured");
  const state = `${randomBytes(16).toString("base64url")}|${safeReturn(returnTo)}`;
  const url = `https://passport.feishu.cn/suite/passport/oauth/authorize?${new URLSearchParams({ client_id: appId, redirect_uri: CALLBACK_URL, response_type: "code", state: sign(state) })}`;
  return { url, stateCookie: sign(state) };
}

/** Only admin paths on this site; anything else (other hosts, protocol-relative) falls back to /admin. */
export function safeReturn(target: string): string {
  let path = target;
  // A proxy's login redirect may pass the whole original URL; keep only its path and query.
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      path = `${u.pathname}${u.search}`;
    } catch {
      return "/admin";
    }
  }
  return /^\/admin(\/|\?|$)/.test(path) && !path.startsWith("//") ? path : "/admin";
}

interface FeishuUser {
  union_id?: string;
  email?: string;
  enterprise_email?: string;
  name?: string;
}

async function feishuUser(code: string): Promise<{ user: FeishuUser; appId: string }> {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  const appSecret = credential("integrations", "FEISHU_LOGIN_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Feishu login app is not configured");
  const tokenRes = await fetch("https://passport.feishu.cn/suite/passport/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: appId, client_secret: appSecret, code, redirect_uri: CALLBACK_URL }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) throw new Error(`Feishu token exchange failed: ${token.error ?? tokenRes.status}`);
  const userRes = await fetch("https://passport.feishu.cn/suite/passport/oauth/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return { user: (await userRes.json()) as FeishuUser, appId };
}

export class LoginRejected extends Error {}

async function createSession(userId: number, userAgent: string | undefined, auth: SessionAuth): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, user_agent, auth_method, auth_binding, auth_claims)
            VALUES (${sha256(token)}, ${userId}, ${randomBytes(18).toString("base64url")}, ${new Date(Date.now() + SESSION_DAYS * 86400_000)}, ${userAgent?.slice(0, 300) ?? null},
                    ${auth.method}, ${auth.binding}, ${auth.claims ? sql.json(auth.claims as never) : null})`;
  return token;
}

/** OAuth callback: verify state, identify the Feishu user, admit only allowlisted admins. */
export async function completeLogin(code: string, state: string, stateCookie: string | undefined, userAgent: string | undefined) {
  const expected = unsign(stateCookie);
  const given = unsign(state);
  if (!expected || !given || expected !== given) throw new LoginRejected("登录状态已失效，请重新登录");
  const returnTo = given.split("|")[1] ?? "/admin";
  // Pin the key and app this sign-in used: a configuration change during the exchange must not rebind it.
  const loginKey = secret();
  const { user: u, appId } = await feishuUser(code);
  const emailClaim = u.enterprise_email ?? u.email;
  const email = typeof emailClaim === "string" ? emailClaim.toLowerCase() || null : null;
  const unionId = typeof u.union_id === "string" ? u.union_id || null : null;
  const claims: FeishuClaims = { appId, unionId, email };
  const auth: SessionAuth = { method: "feishu", claims, binding: sessionBinding("feishu", claims, loginKey) };
  const allowed = (unionId && config.adminUnionIds.includes(unionId)) || (email && config.adminEmails.includes(email));
  if (!allowed) throw new LoginRejected("这个飞书账号没有后台权限");
  const [existing] = await sql<{ id: number }[]>`
    SELECT id FROM admin_users WHERE (${unionId}::text IS NOT NULL AND feishu_union_id = ${unionId}) OR (${email}::text IS NOT NULL AND email = ${email}) LIMIT 1`;
  const [user] = existing
    ? await sql<{ id: number }[]>`UPDATE admin_users SET feishu_union_id = coalesce(feishu_union_id, ${unionId}), email = coalesce(email, ${email}),
        display_name = coalesce(${u.name ?? null}, display_name), last_login_at = now() WHERE id = ${existing.id} RETURNING id`
    : await sql<{ id: number }[]>`INSERT INTO admin_users (feishu_union_id, email, display_name, last_login_at) VALUES (${unionId}, ${email}, ${u.name ?? null}, now()) RETURNING id`;
  const token = await createSession(user!.id, userAgent, auth);
  await audit(`admin:${user!.id}`, "auth.login", null, null, null, { union_id: unionId });
  return { token, returnTo, userId: user!.id };
}

/** The single password admin: one row, found by its reserved address. */
const PASSWORD_ADMIN = "admin@local";

/** Password sign-in: a constant-time comparison of digests, so the length leaks nothing either. */
export async function passwordLogin(password: string, returnTo: string, userAgent: string | undefined) {
  const expected = config.adminPassword;
  if (!expected || expected.length < 12) throw new LoginRejected("还没有设置管理员密码（环境变量 ADMIN_PASSWORD，至少 12 位）");
  const given = createHmac("sha256", "admin-password").update(password).digest();
  const wanted = createHmac("sha256", "admin-password").update(expected).digest();
  if (!timingSafeEqual(given, wanted)) throw new LoginRejected("密码不对");
  const auth: SessionAuth = { method: "password", claims: null, binding: sessionBinding("password", expected, secret()) };
  const [user] = await sql<{ id: number }[]>`
    INSERT INTO admin_users (email, display_name, last_login_at) VALUES (${PASSWORD_ADMIN}, '管理员', now())
    ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id`;
  const token = await createSession(user!.id, userAgent, auth);
  await audit(`admin:${user!.id}`, "auth.login", null, null, null, { method: "password" });
  return { token, returnTo: safeReturn(returnTo), userId: user!.id };
}

export async function sessionPrincipal(cookieHeader: string | undefined): Promise<AdminPrincipal | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) {
    const hash = sha256(token);
    const [row] = await sql<{ user_id: number; csrf_token: string; name: string | null; email: string | null; auth_method: string | null; auth_binding: string | null; auth_claims: unknown }[]>`
      SELECT s.user_id, s.csrf_token, s.auth_method, s.auth_binding, s.auth_claims, u.display_name AS name, u.email
      FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.id_hash = ${hash} AND s.expires_at > now()`;
    if (row) {
      if (sessionAuthorized(row)) return { userId: row.user_id, name: row.name ?? row.email ?? `admin:${row.user_id}`, csrf: row.csrf_token, dev: false };
      // A session seen to be invalid is gone for good: restoring the old configuration does not revive it.
      await sql`DELETE FROM admin_sessions WHERE id_hash = ${hash}`;
    }
  }
  if (config.devAdmin && config.environmentName !== "production") return { userId: null, name: config.devAdmin.displayName, csrf: "dev", dev: true };
  return null;
}

export async function endSession(cookieHeader: string | undefined) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) await sql`DELETE FROM admin_sessions WHERE id_hash = ${sha256(token)}`;
}

export function actorOf(p: AdminPrincipal): string {
  return p.dev ? `dev:${p.name}` : `admin:${p.userId}`;
}
