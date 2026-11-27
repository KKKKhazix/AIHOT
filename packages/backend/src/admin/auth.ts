// Admin identity: the admin password (ADMIN_PASSWORD), with opaque sessions stored hashed
// and an audit trail for every manual change.
// Development may impersonate an admin with DEV_AUTH_ROLE=admin; production refuses to start with it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { safeReturn } from "@aihot/contracts/admin";
import { audit } from "../audit.ts";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

export const SESSION_COOKIE = "aihot_admin";
export const SESSION_DAYS = 30;
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

function sessionBinding(password: string, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify(["admin-session-v1", "password", password])).digest("hex");
}

function sessionAuthorized(row: { auth_method: string | null; auth_binding: string | null }): boolean {
  const key = credential("auth", "SESSION_SECRET");
  if (row.auth_method !== "password" || !key || !row.auth_binding || !/^[0-9a-f]{64}$/.test(row.auth_binding)) return false;
  if (!config.adminPassword || config.adminPassword.length < 12) return false;
  const binding = sessionBinding(config.adminPassword, key);
  return timingSafeEqual(Buffer.from(binding, "hex"), Buffer.from(row.auth_binding, "hex"));
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

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean, path = "/"): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export class LoginRejected extends Error {}

async function createSession(userId: number, userAgent: string | undefined, binding: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, user_agent, auth_method, auth_binding)
            VALUES (${sha256(token)}, ${userId}, ${randomBytes(18).toString("base64url")}, ${new Date(Date.now() + SESSION_DAYS * 86400_000)}, ${userAgent?.slice(0, 300) ?? null},
                    'password', ${binding})`;
  return token;
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
  const binding = sessionBinding(expected, secret());
  const [user] = await sql<{ id: number }[]>`
    INSERT INTO admin_users (email, display_name, last_login_at) VALUES (${PASSWORD_ADMIN}, '管理员', now())
    ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id`;
  const token = await createSession(user!.id, userAgent, binding);
  await audit(`admin:${user!.id}`, "auth.login", null, null, null, { method: "password" });
  return { token, returnTo: safeReturn(returnTo), userId: user!.id };
}

export async function sessionPrincipal(cookieHeader: string | undefined): Promise<AdminPrincipal | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) {
    const hash = sha256(token);
    const [row] = await sql<{ user_id: number; csrf_token: string; name: string | null; email: string | null; auth_method: string | null; auth_binding: string | null }[]>`
      SELECT s.user_id, s.csrf_token, s.auth_method, s.auth_binding, u.display_name AS name, u.email
      FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.id_hash = ${hash} AND s.expires_at > now()`;
    if (row) {
      if (sessionAuthorized(row)) return { userId: row.user_id, name: row.name ?? row.email ?? `admin:${row.user_id}`, csrf: row.csrf_token, dev: false };
      // A session seen to be invalid is gone for good: restoring the old configuration does not revive it.
      await sql`DELETE FROM admin_sessions WHERE id_hash = ${hash}`;
    }
  }
  return devPrincipal();
}

/** Development's stand-in admin (DEV_AUTH_ROLE=admin); never in production. */
export function devPrincipal(): AdminPrincipal | null {
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
