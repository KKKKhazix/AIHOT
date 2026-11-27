// Admin sign-in and the /api/admin guard. Public routes never read the session.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { safeReturn, SIGN_IN_HOME } from "@aihot/contracts/admin";
import { ADMIN } from "@aihot/site";
import { config } from "@aihot/backend/config";
import {
  cookie,
  endSession,
  LoginRejected,
  passwordLogin,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionPrincipal,
  type AdminPrincipal,
} from "@aihot/backend/admin/auth";
import { adminPagePrincipal, previewPrincipal } from "@aihot/backend/admin/preview";
import type { Previewer } from "@aihot/backend/modules";
import { clientIp, sendProblem } from "../http/respond.ts";

/**
 * A cookie is Secure when the request itself arrived over HTTPS: the browser judges it against the
 * page's origin, so a plain-HTTP entry (a LAN address, a published container port) drops a Secure
 * cookie at sign-in and the session never sticks. Behind a TLS-terminating proxy, trustProxy makes
 * `req.protocol` reflect X-Forwarded-Proto, so the public HTTPS entry keeps its Secure cookie.
 */
const secure = (req: FastifyRequest) => req.protocol === "https";

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
      return handlerError(req, reply, error);
    }
  };
}

function handlerError(req: FastifyRequest, reply: FastifyReply, error: unknown) {
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

function readOnlyAccessHandler(
  load: (cookieHeader: string | undefined) => Promise<Previewer | null>,
  label: string,
  fn: (req: FastifyRequest, reply: FastifyReply, previewer: Previewer) => Promise<unknown>,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") {
      reply.header("Allow", "GET, HEAD");
      return sendProblem(req, reply, { status: 405, code: "method_not_allowed", detail: `${label} data is read-only.` });
    }
    const previewer = await load(req.headers.cookie);
    if (!previewer) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: `${label} access required.` });
    try {
      return await fn(req, reply, previewer);
    } catch (error) {
      return handlerError(req, reply, error);
    }
  };
}

/** Gray data is read-only, for engine admins or module-approved previewers. */
export function previewHandler(fn: (req: FastifyRequest, reply: FastifyReply, previewer: Previewer) => Promise<unknown>) {
  return readOnlyAccessHandler(previewPrincipal, "Preview", fn);
}

export function adminPageHandler(fn: (req: FastifyRequest, reply: FastifyReply, previewer: Previewer) => Promise<unknown>) {
  return readOnlyAccessHandler(adminPagePrincipal, "Admin page", fn);
}

export function registerAdminAuth(app: FastifyInstance) {
  for (const [path, load, label] of [
    ["/api/admin/preview", previewPrincipal, "Preview"],
    ["/api/admin/page-access", adminPagePrincipal, "Admin page"],
  ] as const) {
    app.get(path, async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const principal = await load(req.headers.cookie);
      if (!principal) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: `${label} access required.`, cacheControl: "private, no-store" });
      return { name: principal.name };
    });
  }
  if (!ADMIN) return;

  // The web admin sends a signed-out visitor here with ?return=.
  app.get("/api/auth/login", async (req, reply) => {
    const returnTo = String((req.query as Record<string, string>).return ?? SIGN_IN_HOME);
    // A live session does not need signing in again: go straight to where the visitor was headed.
    if (await sessionPrincipal(req.headers.cookie)) return reply.header("Cache-Control", "no-store").redirect(safeReturn(returnTo), 302);
    return reply.header("Cache-Control", "no-store").redirect(loginPage(returnTo), 302);
  });

  app.get("/api/auth/options", async (_req, reply) => reply.header("Cache-Control", "no-store").send({ password: !!config.adminPassword }));

  // The sign-in and sign-out forms post as plain HTML forms; only these routes read that format.
  app.register(async (form) => {
    form.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    form.post("/api/auth/password", async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string>;
      const returnTo = String(b.return ?? SIGN_IN_HOME);
      reply.header("Cache-Control", "no-store");
      if (tooManyAttempts(clientIp(req))) return reply.redirect(loginPage(returnTo, "too-many"), 303);
      try {
        const { token, returnTo: target } = await passwordLogin(String(b.password ?? ""), returnTo, req.headers["user-agent"]);
        reply.header("Set-Cookie", cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, secure(req)));
        return reply.redirect(target, 303);
      } catch (error) {
        if (!(error instanceof LoginRejected)) req.log.error({ err: error }, "admin login failed");
        return reply.redirect(loginPage(returnTo, error instanceof LoginRejected && /ADMIN_PASSWORD/.test(error.message) ? "unset" : "wrong"), 303);
      }
    });
    // Signing out is a plain form too: outside this scope its empty urlencoded body would be a 415.
    form.post("/api/auth/logout", async (req, reply) => {
      await endSession(req.headers.cookie);
      reply.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, secure(req))).header("Cache-Control", "no-store");
      return reply.redirect("/", 303);
    });
  });
}
