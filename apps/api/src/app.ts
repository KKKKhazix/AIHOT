import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { OAUTH_PROBE_PATHS, resolveRedirect } from "@aihot/contracts/http-policy";
import { sql } from "@aihot/backend/db";
import { logError } from "@aihot/backend/lib/log-error";
import { serverModules } from "@aihot/backend/modules";
import { registerSite } from "./routes/site.ts";
import { registerOg } from "./routes/og.ts";
import { registerAdminAuth } from "./routes/admin-auth.ts";
import { registerAdmin } from "./routes/admin.ts";
import { registerIngest } from "./routes/ingest.ts";
import { registerV1, registerV1Fallbacks } from "./routes/v1.ts";
import { registerAgent } from "./routes/agent.ts";
import { registerMedia } from "./routes/media.ts";
import { registerFeeds } from "./routes/feeds.ts";
import { registerStatic } from "./routes/static.ts";
import { registerMcp } from "./routes/mcp.ts";
import { sendProblem } from "./http/respond.ts";

/** Quiet ordinary access logs, while keeping errors that happen after the route has returned. */
class RequestLogs extends LogController {
  readonly failures = new WeakSet<IncomingMessage>();
  override incomingRequest() {}
  override routeNotFound() {}
  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply) {
    if (error && !this.failures.has(request.raw)) super.requestCompleted(error, request, reply);
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const logs = new RequestLogs();
  const app = Fastify({
    // Access logs never record query strings (tokens).
    logger: {
      level: process.env.LOG_LEVEL || "info", redact: ["req.headers.authorization", "req.headers.cookie"],
      serializers: { err: logError, req: (req) => ({ method: req.method, path: req.url.split("?")[0] }) },
    },
    logController: logs,
    trustProxy: true,
    genReqId: () => randomUUID(),
    bodyLimit: 10 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: false, maxParamLength: 300 },
  });

  app.setChildLoggerFactory((logger, bindings, options, request) => {
    const child = logger.child({ ...bindings, method: request.method, path: (request.url ?? "/").split("?")[0] }, options);
    // A route's root-cause error already explains this request; the completion hook need not repeat it.
    for (const level of ["warn", "error", "fatal"] as const) {
      const write = child[level];
      child[level] = function (this: typeof child, ...args: unknown[]) {
        if (args[0] && typeof args[0] === "object" && "err" in args[0]) logs.failures.add(request);
        return Reflect.apply(write, this, args);
      } as typeof write;
    }
    return child;
  });

  app.addHook("onResponse", async (req, reply) => {
    const path = (req.raw.url ?? "").split("?")[0] ?? "/";
    // The reverse proxy logs every request; the process only notes the slow and the failed.
    const ms = Math.round(reply.elapsedTime);
    if (!logs.failures.has(req.raw) && (reply.statusCode >= 500 || (ms >= 1000 && path !== "/api/mcp" && !path.startsWith("/api/img-proxy")))) {
      req.log.warn({ method: req.method, path, status: reply.statusCode, ms }, "request");
    }
    for (const m of serverModules()) m.on?.requestAnswered?.(req, reply, path);
  });

  // Central redirect table (shared with the web server).
  app.addHook("onRequest", async (req, reply) => {
    const raw = req.raw.url ?? "/";
    const qi = raw.indexOf("?");
    const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
    const search = qi >= 0 ? raw.slice(qi) : "";
    if (OAUTH_PROBE_PATHS.includes(pathname)) {
      return reply.code(404).header("Cache-Control", "public, max-age=3600").type("application/json").send('{"error":"not_found"}');
    }
    const decision = resolveRedirect(pathname, search);
    if (decision) {
      for (const [k, v] of Object.entries(decision.headers)) reply.header(k, v);
      if (decision.location) return reply.code(decision.status).header("Location", decision.location).send();
      return reply.code(decision.status).type("text/plain; charset=utf-8").send(decision.status === 410 ? "Gone" : "Not found");
    }
  });

  app.get("/api/health", async (_req, reply) => {
    const started = Date.now();
    await sql`SELECT 1`;
    return reply.header("Cache-Control", "no-store").send({ ok: true, db: "ok", ms: Date.now() - started, release: process.env.AIHOT_RELEASE ?? "dev" });
  });

  registerSite(app);
  registerOg(app);
  registerAdminAuth(app);
  registerAdmin(app);
  registerIngest(app);
  registerV1(app);
  registerAgent(app);
  registerMedia(app);
  registerFeeds(app);
  registerStatic(app);
  registerMcp(app);
  for (const m of serverModules()) m.http?.(app);
  registerV1Fallbacks(app);

  app.setNotFoundHandler((req, reply) => {
    if ((req.raw.url ?? "").startsWith("/api/")) {
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "No such endpoint." });
    }
    return reply.code(404).type("text/plain; charset=utf-8").header("Cache-Control", "public, max-age=60").send("Not found");
  });

  app.setErrorHandler((error, req, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 400 || status === 413 || status === 415) {
      // A malformed or oversized request is the client's: one line, no stack trace in the error log.
      req.log.info({ status, code: (error as { code?: string }).code }, "request refused");
      return sendProblem(req, reply, { status: status === 400 ? 400 : status, code: "invalid_request", detail: "The request could not be processed." });
    }
    req.log.error({ err: error }, "unhandled");
    return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "Temporarily unavailable.", retryAfter: 30 });
  });

  return app;
}
