// Public API v1 (long-term). Field shapes follow the OpenAPI document at /openapi-v1.json (the paths stay
// /api/v1); each operation's query parameters and Cache-Control are listed in V1_OPERATIONS.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PUBLIC_API_CATEGORY_KEYS, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { config } from "@aihot/backend/config";
import { InvalidCursorError } from "@aihot/backend/lib/cursor";
import { SearchBusyError } from "@aihot/backend/publication/pool";
import { selectedChanges, selectedSnapshot, SnapshotRequiredError, v1Items } from "@aihot/backend/publication/v1";
import { resolveStory, v1HotTopics, v1Story } from "@aihot/backend/publication/stories";
import { isPeriodKey, v1Dailies, v1Daily, v1Period, v1Periods } from "@aihot/backend/publication/reports";
import { isValidDate } from "@aihot/contracts/time";
import { requestNotice } from "@aihot/backend/modules";
import { applyPublicHeaders, QueryError, sendJsonWithNotice, sendJsonWithEtag, sendProblem, strictQuery } from "../http/respond.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const op = (queryKeys: readonly string[], cacheControl: string) => ({ queryKeys, cacheControl });

export const V1_OPERATIONS = {
  items: op(["mode", "category", "window", "by", "q", "limit", "cursor"], "public, max-age=60, s-maxage=60, stale-while-revalidate=300"),
  hotTopics: op([], "public, max-age=60, s-maxage=60, stale-while-revalidate=60"),
  storyByPublicId: op([], "public, max-age=60, s-maxage=60, stale-while-revalidate=60"),
  dailies: op(["limit"], "public, max-age=60, s-maxage=60, stale-while-revalidate=300"),
  latestDaily: op([], "public, max-age=60, s-maxage=60, stale-while-revalidate=300"),
  dailyByDate: op([], "public, max-age=300, s-maxage=300, stale-while-revalidate=3600"),
  weeklies: op(["limit"], "public, max-age=300, s-maxage=300, stale-while-revalidate=3600"),
  latestWeekly: op([], "public, max-age=300, s-maxage=300, stale-while-revalidate=3600"),
  weeklyByWeek: op([], "public, max-age=300, s-maxage=300, stale-while-revalidate=3600"),
  monthlies: op(["limit"], "public, max-age=300, s-maxage=300, stale-while-revalidate=3600"),
  latestMonthly: op([], "public, max-age=300, s-maxage=300, stale-while-revalidate=3600"),
  monthlyByMonth: op([], "public, max-age=300, s-maxage=300, stale-while-revalidate=3600"),
  selectedSnapshot: op(["fields", "limit", "page"], "public, max-age=300, s-maxage=300, stale-while-revalidate=900"),
  selectedChanges: op(["cursor", "limit"], "public, max-age=60, s-maxage=60, stale-while-revalidate=60"),
};

export function intParam(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new QueryError(`${name} must be an integer from ${min} to ${max}.`);
  const n = Number(value);
  if (n < min || n > max) throw new QueryError(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

export function enumParam<T extends string>(value: string | undefined, name: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new QueryError(allowed.length === 2 ? `${name} must be '${allowed[0]}' or '${allowed[1]}'.` : `${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

type SendOptions = Parameters<typeof sendJsonWithEtag>[3];

/** Every v1 JSON answer: with a weak ETag, 304 when it matches, and a module's reminder for the person behind the request on top. */
export function sendV1(req: FastifyRequest, reply: FastifyReply, body: object, opts: SendOptions) {
  return sendJsonWithNotice(req, reply, body, requestNotice("json", req), opts);
}

/** Wraps a v1 handler with shared error mapping. Errors never leak internals. */
export function publicHandler(fn: Handler): Handler {
  return async (req, reply) => {
    applyPublicHeaders(reply);
    try {
      return await fn(req, reply);
    } catch (error) {
      if (error instanceof QueryError) return sendProblem(req, reply, { status: 400, code: "invalid_request", title: "Invalid request", detail: error.message });
      if (error instanceof InvalidCursorError) {
        return sendProblem(req, reply, { status: 400, code: "invalid_cursor", title: "Invalid cursor", detail: "The cursor is malformed." });
      }
      if (error instanceof SnapshotRequiredError) {
        return sendProblem(req, reply, {
          status: 409, code: "snapshot_required", title: "Snapshot required",
          detail: "Missing or invalid v1 cursor; fetch /api/v1/selected/snapshot first.",
        });
      }
      if (error instanceof SearchBusyError) {
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "Search is busy; retry later.", retryAfter: error.retryAfter });
      }
      req.log.error({ err: error, path: req.url.split("?")[0] }, "public api error");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "The service is temporarily unavailable; retry later.", retryAfter: 30 });
    }
  };
}

export function registerV1(app: FastifyInstance) {
  app.get("/api/v1/items", publicHandler(async (req, reply) => {
    const q = strictQuery(req, V1_OPERATIONS.items.queryKeys);
    const mode = enumParam(q.mode, "mode", ["selected", "all"] as const, "selected");
    const window = enumParam(q.window, "window", ["24h", "7d"] as const, "7d");
    const by = enumParam(q.by, "by", ["timeline", "published"] as const, "timeline");
    const category = q.category === undefined ? null : enumParam<PublicApiCategoryKey>(q.category, "category", PUBLIC_API_CATEGORY_KEYS, PUBLIC_API_CATEGORY_KEYS[0]);
    let search: string | null = null;
    if (q.q !== undefined) {
      search = q.q.trim();
      const len = [...search].length;
      if (len < 2 || len > 200) throw new QueryError("q must contain 2 to 200 characters.");
    }
    const limit = intParam(q.limit, "limit", 1, 100, 50);
    if (q.cursor !== undefined && q.cursor.length === 0) throw new InvalidCursorError("empty cursor");
    const body = await v1Items({ mode, window, by, category, q: search, limit, cursor: q.cursor ?? null });
    return sendV1(req, reply, body, { etagPrefix: "v1-items", cacheControl: V1_OPERATIONS.items.cacheControl });
  }));

  app.get("/api/v1/hot-topics", publicHandler(async (req, reply) => {
    strictQuery(req, V1_OPERATIONS.hotTopics.queryKeys);
    const body = await v1HotTopics();
    return sendV1(req, reply, body, { etagPrefix: "v1-hot", cacheControl: V1_OPERATIONS.hotTopics.cacheControl });
  }));

  app.get("/api/v1/stories/:publicId", publicHandler(async (req, reply) => {
    strictQuery(req, V1_OPERATIONS.storyByPublicId.queryKeys);
    const publicId = (req.params as { publicId: string }).publicId;
    if (publicId.length > 128) throw new QueryError("publicId must be a short opaque id.");
    const found = await resolveStory(publicId);
    if (found.kind === "merged") {
      return reply.code(308).header("Location", `/api/v1/stories/${found.target}`).header("Cache-Control", V1_OPERATIONS.storyByPublicId.cacheControl).send();
    }
    const body = found.kind === "found" ? await v1Story(found.storyId) : null;
    if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `No public story exists for ${publicId}.`, cacheControl: "public, max-age=60" });
    return sendV1(req, reply, body, { etagPrefix: "v1-story", cacheControl: V1_OPERATIONS.storyByPublicId.cacheControl });
  }));

  app.get("/api/v1/dailies", publicHandler(async (req, reply) => {
    const q = strictQuery(req, V1_OPERATIONS.dailies.queryKeys);
    const limit = intParam(q.limit, "limit", 1, 180, 30);
    return sendV1(req, reply, await v1Dailies(limit), { etagPrefix: "v1-dailies", cacheControl: V1_OPERATIONS.dailies.cacheControl });
  }));

  app.get("/api/v1/dailies/latest", publicHandler(async (req, reply) => {
    strictQuery(req, V1_OPERATIONS.latestDaily.queryKeys);
    const body = await v1Daily("latest");
    if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "No daily report has been published yet." });
    return sendV1(req, reply, body, { etagPrefix: "v1-daily", cacheControl: V1_OPERATIONS.latestDaily.cacheControl });
  }));

  app.get("/api/v1/dailies/:date", publicHandler(async (req, reply) => {
    strictQuery(req, V1_OPERATIONS.dailyByDate.queryKeys);
    const date = (req.params as { date: string }).date;
    if (!isValidDate(date)) throw new QueryError("date must be a real YYYY-MM-DD calendar date.");
    const body = await v1Daily(date);
    if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `No daily report exists for ${date}.`, cacheControl: "public, max-age=60" });
    return sendV1(req, reply, body, { etagPrefix: "v1-daily", cacheControl: V1_OPERATIONS.dailyByDate.cacheControl });
  }));

  // Weeklies and monthlies: an index, the latest issue and one issue by ISO week or month.
  for (const p of [
    { kind: "weekly", path: "weeklies", param: "week", name: "weekly", form: "a real ISO week such as 2026-W39", index: V1_OPERATIONS.weeklies, latest: V1_OPERATIONS.latestWeekly, byKey: V1_OPERATIONS.weeklyByWeek },
    { kind: "monthly", path: "monthlies", param: "month", name: "monthly", form: "a real month such as 2026-09", index: V1_OPERATIONS.monthlies, latest: V1_OPERATIONS.latestMonthly, byKey: V1_OPERATIONS.monthlyByMonth },
  ] as const) {
    app.get(`/api/v1/${p.path}`, publicHandler(async (req, reply) => {
      const q = strictQuery(req, p.index.queryKeys);
      const limit = intParam(q.limit, "limit", 1, 60, 12);
      return sendV1(req, reply, await v1Periods(p.kind, limit), { etagPrefix: `v1-${p.path}`, cacheControl: p.index.cacheControl });
    }));
    app.get(`/api/v1/${p.path}/latest`, publicHandler(async (req, reply) => {
      strictQuery(req, p.latest.queryKeys);
      const body = await v1Period(p.kind, "latest");
      if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `No ${p.name} report has been published yet.` });
      return sendV1(req, reply, body, { etagPrefix: `v1-${p.name}`, cacheControl: p.latest.cacheControl });
    }));
    app.get(`/api/v1/${p.path}/:${p.param}`, publicHandler(async (req, reply) => {
      strictQuery(req, p.byKey.queryKeys);
      const key = (req.params as Record<string, string>)[p.param]!;
      if (!isPeriodKey(p.kind, key)) throw new QueryError(`${p.param} must be ${p.form}.`);
      const body = await v1Period(p.kind, key);
      if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `No ${p.name} report exists for ${key}.`, cacheControl: "public, max-age=60" });
      return sendV1(req, reply, body, { etagPrefix: `v1-${p.name}`, cacheControl: p.byKey.cacheControl });
    }));
  }

  app.get("/api/v1/selected/snapshot", publicHandler(async (req, reply) => {
    const q = strictQuery(req, V1_OPERATIONS.selectedSnapshot.queryKeys);
    const fields = q.fields === undefined ? undefined : enumParam(q.fields, "fields", ["default", "minimal"] as const, "default");
    const limit = intParam(q.limit, "limit", 1, 1000, 500);
    const body = await selectedSnapshot({ fields, limit, page: q.page ?? null });
    // asOf (and the next-page token that carries it) differ per request; the page content does not.
    const etagOf = { fields: body.fields, cursor: body.cursor, count: body.count, hasMore: body.hasMore, items: body.items };
    return sendV1(req, reply, body, { etagPrefix: "v1-snapshot", cacheControl: V1_OPERATIONS.selectedSnapshot.cacheControl, etagOf });
  }));

  app.get("/api/v1/selected/changes", publicHandler(async (req, reply) => {
    const q = strictQuery(req, V1_OPERATIONS.selectedChanges.queryKeys);
    const limit = intParam(q.limit, "limit", 1, 100, 100);
    if (!q.cursor) throw new SnapshotRequiredError("missing cursor");
    const body = await selectedChanges({ cursor: q.cursor, limit });
    return sendV1(req, reply, body, { etagPrefix: "v1-changes", cacheControl: V1_OPERATIONS.selectedChanges.cacheControl });
  }));
}

const notAllowed: Handler = async (req, reply) => {
  applyPublicHeaders(reply);
  reply.header("Allow", "GET, HEAD, OPTIONS");
  return sendProblem(req, reply, { status: 405, code: "method_not_allowed", detail: "This endpoint supports only GET, HEAD, and OPTIONS." });
};
const preflight: Handler = async (_req, reply) => {
  applyPublicHeaders(reply);
  return reply.code(204).header("Cache-Control", "public, max-age=86400").send();
};

/** A read-only public address (a path or a wildcard): CORS preflight, and 405 for any other method. */
export function readOnlyMethods(app: FastifyInstance, url: string) {
  app.options(url, preflight);
  // A read-only operation never interprets a rejected method's body: even malformed JSON and
  // unsupported media types must receive the same 405 and readable public error headers.
  app.route({ method: ["POST", "PUT", "PATCH", "DELETE", "TRACE"], url, onRequest: notAllowed, handler: notAllowed });
}

/** Registered last: CORS preflight, 405 for other methods, Problem 404 for undefined v1 paths. */
export function registerV1Fallbacks(app: FastifyInstance) {
  const notFound: Handler = async (req, reply) => {
    applyPublicHeaders(reply);
    const path = (req.raw.url ?? "").split("?")[0];
    return sendProblem(req, reply, {
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: `No public API v1 operation exists at ${path}. Recent items are at /api/v1/items; every operation is listed at ${config.siteUrl}/openapi-v1.json`,
    });
  };
  for (const url of ["/api/v1", "/api/v1/*", "/openapi-v1.json"]) readOnlyMethods(app, url);
  app.get("/api/v1", notFound);
  app.get("/api/v1/*", notFound);
}
