// First-party site API (/api/site/*). Not public, not versioned, never called /api/v2.
// Reads through the same public read layer as v1; no cookies are read or set.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCategoryKey, isChannelKey, type CategoryKey, type ChannelKey } from "@aihot/contracts/taxonomy";
import type { ReportIndexResponse, ReportLatestPage, ReportNavigationResponse, SiteContact } from "@aihot/contracts/site";
import { InvalidCursorError } from "@aihot/backend/lib/cursor";
import { exportMarkdown, loadItemDetail } from "@aihot/backend/publication/detail";
import { loadPool, SearchBusyError } from "@aihot/backend/publication/pool";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadStoryFollowups } from "@aihot/backend/publication/followups";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { loadHotStrip } from "@aihot/backend/publication/hot";
import { loadChangelog, siteMeta } from "@aihot/backend/site/meta";
import { loadContact, loadMakerAvatar } from "@aihot/backend/site/contact";
import { loadSiteStats } from "@aihot/backend/site/stats";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { listTopicSummaries, loadTopicPage } from "@aihot/backend/publication/topics";
import { registerFeedback } from "./feedback.ts";
import { loadHot, loadStoryDetail, resolveStory } from "@aihot/backend/publication/stories";
import { listReports, loadReport, reportNavigation, loadReportNavigation, loadReportMonth, type ReportKind } from "@aihot/backend/publication/reports";
import { looseQuery, sendJsonWithEtag, sendProblem } from "../http/respond.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

class BadRequest extends Error {}

export function siteHandler(fn: Handler): Handler {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (error) {
      if (error instanceof BadRequest) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: error.message });
      if (error instanceof InvalidCursorError) return sendProblem(req, reply, { status: 400, code: "invalid_cursor", detail: error.message });
      if (error instanceof SearchBusyError) {
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "search busy", retryAfter: error.retryAfter });
      }
      req.log.error({ err: error, path: req.url.split("?")[0] }, "site api error");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "temporarily unavailable", retryAfter: 10 });
    }
  };
}

export interface FilterParams {
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
}

export function parseFilters(q: Record<string, string>): FilterParams {
  const channel = q.channel ?? "all";
  if (!isChannelKey(channel)) throw new BadRequest("invalid channel");
  const category = q.category ?? null;
  if (category !== null && !isCategoryKey(category)) throw new BadRequest("invalid category");
  const tag = q.tag?.trim() ? q.tag.trim().slice(0, 60) : null;
  return { channel, category: category as CategoryKey | null, tag };
}

export function registerSite(app: FastifyInstance) {
  app.get("/api/site/meta", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, siteMeta(), { etagPrefix: "meta", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/timeline", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const filters = parseFilters(q);
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 40);
    const unfiltered = filters.channel === "all" && !filters.category && !filters.tag && !q.cursor;
    const [data, hot] = await Promise.all([
      loadTimeline({ ...filters, cursor: q.cursor || null, limit }),
      unfiltered ? loadHotStrip() : null,
    ]);
    // Any cache in front and the home page built from this answer share one absolute deadline.
    reply.header("X-Accel-Expires", `@${Math.floor(Date.now() / 1000) + 60}`);
    return sendJsonWithEtag(req, reply, { ...data, hot }, { etagPrefix: "tl", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/pool", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const filters = parseFilters(q);
    const page = Math.min(Math.max(Number(q.page) || 1, 1), 50);
    const search = q.q?.trim() ? q.q.trim().slice(0, 200) : null;
    const tab = q.tab === "relevance" ? "relevance" : "time";
    return sendJsonWithEtag(req, reply, await loadPool({ ...filters, q: search, tab, page }), { etagPrefix: "pool", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/items/:id", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found" });
    const result = await loadItemDetail(id);
    if (result.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, result.item, { etagPrefix: "item", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/items/:id/original", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found" });
    const result = await loadItemDetail(id, "original");
    if (result.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, result.item, { etagPrefix: "item-original", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/stories/:publicId/followups", siteHandler(async (req, reply) => {
    const result = await loadStoryFollowups((req.params as { publicId: string }).publicId);
    if (!result) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not found" });
    return reply.header("Cache-Control", "no-store").send(result);
  }));

  app.get("/api/site/groups/:factId/reports", siteHandler(async (req, reply) => {
    const data = await loadGroupReports({ factPublicId: (req.params as { factId: string }).factId, ...parseFilters(looseQuery(req)) });
    if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "reading group unavailable" });
    return reply.header("Cache-Control", "no-store").send(data);
  }));

  app.get("/api/site/contact", siteHandler(async (req, reply) => {
    const [contact, makerAvatar] = await Promise.all([loadContact(), loadMakerAvatar()]);
    const body: SiteContact = { ...contact, makerAvatar };
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "contact", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/stats", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, await loadSiteStats(), { etagPrefix: "stats", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/changelog", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, loadChangelog(), { etagPrefix: "changelog", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/items/availability", siteHandler(async (req, reply) => {
    const ids = (looseQuery(req).ids ?? "").split(",").filter(Boolean);
    reply.header("Cache-Control", "no-store");
    return reply.send(await itemAvailability(ids));
  }));

  app.get("/api/site/topics", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, await listTopicSummaries(), { etagPrefix: "topics", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/topics/:slug", siteHandler(async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const data = await loadTopicPage(slug, Number(looseQuery(req).page ?? 1));
    if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "topic page not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "topic", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  registerFeedback(app);

  app.get("/api/site/hot", siteHandler(async (req, reply) => {
    const data = await loadHot();
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "hot", cacheControl: "public, max-age=30, s-maxage=30" });
  }));

  app.get("/api/site/stories/:publicId", siteHandler(async (req, reply) => {
    const publicId = (req.params as { publicId: string }).publicId;
    const found = await resolveStory(publicId);
    if (found.kind === "merged") {
      return reply.code(308).header("Location", `/api/site/stories/${found.target}`).header("Cache-Control", "public, max-age=300").send({ mergedInto: found.target });
    }
    if (found.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not found", cacheControl: "public, max-age=60" });
    const data = await loadStoryDetail(found.storyId);
    if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "story not public", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "story", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/reports/:kind", siteHandler(async (req, reply) => {
    const kind = (req.params as { kind: string }).kind;
    if (!["daily", "weekly", "monthly"].includes(kind)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "unknown report kind" });
    const body: ReportIndexResponse = { kind: kind as ReportKind, items: await listReports(kind as ReportKind) };
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "reports", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  // The latest report page needs its archive selector and the report in one HTTP request.
  app.get("/api/site/reports/:kind/latest-page", siteHandler(async (req, reply) => {
    const kind = (req.params as { kind: string }).kind;
    if (!["daily", "weekly", "monthly"].includes(kind)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "unknown report kind" });
    const index = await listReports(kind as ReportKind);
    const report = index[0] ? await loadReport(kind as ReportKind, index[0].key) : null;
    const body: ReportLatestPage = { index: reportNavigation(kind as ReportKind, index, report?.key ?? ""), report };
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "report-latest", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/reports/:kind/navigation/:key", siteHandler(async (req, reply) => {
    const { kind, key } = req.params as { kind: string; key: string };
    if (!["daily", "weekly", "monthly"].includes(kind) || !/^\d{4}-(\d{2}(-\d{2})?|W\d{2})$/.test(key)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found" });
    const body: ReportNavigationResponse = { items: await loadReportNavigation(kind as ReportKind, key) };
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "report-navigation", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/reports/daily/months/:month", siteHandler(async (req, reply) => {
    const { month } = req.params as { month: string };
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "month not found" });
    const body: ReportNavigationResponse = { items: await loadReportMonth("daily", month) };
    return sendJsonWithEtag(req, reply, body, { etagPrefix: "report-month", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/reports/:kind/:key", siteHandler(async (req, reply) => {
    const { kind, key } = req.params as { kind: string; key: string };
    if (!["daily", "weekly", "monthly"].includes(kind) || !/^\d{4}-(\d{2}(-\d{2})?|W\d{2})$/.test(key)) {
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found" });
    }
    const data = await loadReport(kind as ReportKind, key);
    if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "report not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "report", cacheControl: "public, max-age=120, s-maxage=120" });
  }));

  // Markdown export: attachment, 404 when there is nothing to export (same predicate as the button).
  app.get("/items/:id/markdown", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    const md = await exportMarkdown(id);
    if (!md) return reply.code(404).header("Cache-Control", "public, max-age=60").type("text/plain; charset=utf-8").send("Not found");
    return reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${md.filename}"`)
      .header("Cache-Control", "public, max-age=300, s-maxage=300")
      .header("X-Robots-Tag", "noindex")
      .send(md.body);
  }));
}
