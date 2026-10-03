// Admin sign-in and the /api/admin guard. Public routes never read the session.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { AdminMe } from "@aihot/contracts/admin";
import { SITE } from "@aihot/industry/site";
import { config } from "@aihot/backend/config";
import {
  completeLogin,
  cookie,
  endSession,
  feishuLoginConfigured,
  LoginRejected,
  loginRedirect,
  parseCookies,
  passwordLogin,
  safeReturn,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionPrincipal,
  STATE_COOKIE,
  type AdminPrincipal,
} from "@aihot/backend/admin/auth";
import { sendProblem } from "../http/respond.ts";

/** Cookies are Secure whenever the site is served over HTTPS. */
const secure = () => config.siteUrl.startsWith("https://");

/**
 * Password attempts: at most 10 per client address and 50 in all per 15 minutes. The overall cap holds
 * even when a client forges its address; with a 12+ character password that is far too slow to guess.
 */
const attempts = new Map<string, number[]>();
function over(key: string, limit: number, now: number): boolean {
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > limit;
}
function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  if (attempts.size > 5000) attempts.clear();
  const perClient = over(`ip:${ip}`, 10, now);
  return over("all", 50, now) || perClient;
}

const loginPage = (returnTo: string, error?: string) => `/admin/login?${new URLSearchParams({ return: safeReturn(returnTo), ...(error ? { error } : {}) })}`;

export type AdminHandler = (req: FastifyRequest, reply: FastifyReply, admin: AdminPrincipal) => Promise<unknown>;

/** Guard for /api/admin/*: a live session (or the development stand-in); writes need the CSRF token. */
export function adminHandler(fn: AdminHandler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    const admin = await sessionPrincipal(req.headers.cookie);
    if (!admin) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Sign in to the admin first." });
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-csrf-token"] !== admin.csrf) {
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "Missing or stale CSRF token." });
    }
    try {
      return await fn(req, reply, admin);
    } catch (error) {
      if (error instanceof ZodError) {
        return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: error.issues.map((issue) => `${issue.path.join(".") || "请求"}: ${issue.message}`).join("; ").slice(0, 300) });
      }
      if ((error as { statusCode?: number }).statusCode === 400 || error instanceof SyntaxError) {
        return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: String((error as Error).message).slice(0, 300) });
      }
      if ((error as { code?: string }).code === "conflict") return sendProblem(req, reply, { status: 409, code: "conflict", detail: (error as Error).message });
      req.log.error({ err: error, path: req.url.split("?")[0] }, "admin api error");
      return sendProblem(req, reply, { status: 500, code: "internal_error", detail: String((error as Error).message).slice(0, 300) });
    }
  };
}

/** Feishu sign-in: the state cookie, then Feishu's authorization page. */
function feishuRedirect(reply: FastifyReply, returnTo: string) {
  const { url, stateCookie } = loginRedirect(returnTo);
  reply.header("Set-Cookie", cookie(STATE_COOKIE, stateCookie, 600, secure())).header("Cache-Control", "no-store");
  return reply.redirect(url, 302);
}

export function registerAdminAuth(app: FastifyInstance) {
  // The web admin sends a signed-out visitor here with ?return=. With Feishu as the only way in, sign-in
  // starts there at once; otherwise the sign-in page (in the web app) offers the ways in.
  app.get("/api/auth/login", async (req, reply) => {
    const returnTo = String(
      (req.query as Record<string, string>).return
      ?? "/admin",
    );
    if (feishuLoginConfigured() && !config.adminPassword) return feishuRedirect(reply, returnTo);
    return reply.header("Cache-Control", "no-store").redirect(loginPage(returnTo), 302);
  });

  app.get("/api/auth/options", async (_req, reply) => reply.header("Cache-Control", "no-store").send({ password: !!config.adminPassword, feishu: feishuLoginConfigured() }));

  // The sign-in form posts as a plain HTML form; only this route reads that format.
  app.register(async (form) => {
    form.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    form.post("/api/auth/password", async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string>;
      const returnTo = String(b.return ?? "/admin");
      reply.header("Cache-Control", "no-store");
      if (tooManyAttempts(String(req.ip))) return reply.redirect(loginPage(returnTo, "too-many"), 303);
      try {
        const { token, returnTo: target } = await passwordLogin(String(b.password ?? ""), returnTo, req.headers["user-agent"]);
        reply.header("Set-Cookie", cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, secure()));
        return reply.redirect(target, 303);
      } catch (error) {
        if (!(error instanceof LoginRejected)) req.log.error({ err: error }, "admin login failed");
        return reply.redirect(loginPage(returnTo, error instanceof LoginRejected && /ADMIN_PASSWORD/.test(error.message) ? "unset" : "wrong"), 303);
      }
    });
  });

  // Feishu sign-in (FEISHU_LOGIN_APP_ID / FEISHU_LOGIN_APP_SECRET and an allowlist), from the sign-in page.
  app.get("/api/auth/feishu", async (req, reply) => {
    const returnTo = String((req.query as Record<string, string>).return ?? "/admin");
    if (!feishuLoginConfigured()) return reply.header("Cache-Control", "no-store").redirect(loginPage(returnTo), 302);
    return feishuRedirect(reply, returnTo);
  });

  // The callback registered in the Feishu open platform: the state cookie comes back here.
  app.get("/api/auth/callback", async (req, reply) => {
    const q = req.query as Record<string, string>;
    reply.header("Cache-Control", "no-store");
    try {
      const { token, returnTo } = await completeLogin(String(q.code ?? ""), String(q.state ?? ""), parseCookies(req.headers.cookie)[STATE_COOKIE], req.headers["user-agent"]);
      reply.header("Set-Cookie", [cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, secure()), cookie(STATE_COOKIE, "", 0, secure())]);
      return reply.redirect(returnTo, 302);
    } catch (error) {
      const message = error instanceof LoginRejected ? error.message : "登录失败，请稍后再试";
      if (!(error instanceof LoginRejected)) req.log.error({ err: error }, "admin login failed");
      return reply.code(403).type("text/html; charset=utf-8").send(`<!doctype html><meta charset="utf-8"><title>登录失败 · ${SITE.name}</title><p style="font:16px system-ui;padding:40px">${message}。<a href="/api/auth/login">重新登录</a></p>`);
    }
  });

  // For a reverse proxy that guards /admin itself (auth_request): 204 with a live session, else 401.
  // Only the session cookie counts here, never the development stand-in.
  app.get("/api/auth/check", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const admin = await sessionPrincipal(req.headers.cookie);
    return reply.code(admin && !admin.dev ? 204 : 401).send();
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await endSession(req.headers.cookie);
    reply.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, secure())).header("Cache-Control", "no-store");
    return reply.redirect("/", 303);
  });

  app.get("/api/admin/me", adminHandler(async (_req, _reply, admin): Promise<AdminMe> => ({ name: admin.name, csrf: admin.csrf, dev: admin.dev })));
}
