import { FEATURES } from "@aihot/industry/features";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { V1_CACHE_CONTROL } from "@aihot/contracts/http-policy";
import { PUBLIC_API_CATEGORY_KEYS, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { isValidDate } from "@aihot/contracts/time";
import { agentGuide, codexAnswer, dailyAnswer, hotAnswer, latestAnswer, searchAnswer, searchItems, storyAnswer } from "@aihot/backend/publication/agent";
import { v1Items } from "@aihot/backend/publication/v1";
import { resolveStory, v1HotTopics, v1Story } from "@aihot/backend/publication/stories";
import { v1Daily } from "@aihot/backend/publication/reports";
import { codexResetPage } from "@aihot/backend/monitor/read";
import { QueryError, sendProblem, sendTextWithEtag, strictQuery } from "../http/respond.ts";
import { enumParam, intParam, publicHandler } from "./v1.ts";

function markdown(req: FastifyRequest, reply: FastifyReply, text: string, etagPrefix: string, cacheControl: string) {
  return sendTextWithEtag(req, reply, text, { etagPrefix, cacheControl, contentType: "text/markdown; charset=utf-8" });
}

function listParams(q: Record<string, string>) {
  return {
    window: enumParam(q.window, "window", ["24h", "7d"] as const, "24h"),
    category: q.category === undefined ? null : enumParam<PublicApiCategoryKey>(q.category, "category", PUBLIC_API_CATEGORY_KEYS, PUBLIC_API_CATEGORY_KEYS[0]),
    limit: intParam(q.limit, "limit", 1, 30, 10),
  };
}

export function registerAgent(app: FastifyInstance) {
  app.get("/api/v1/agent", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    return markdown(req, reply, agentGuide(), "agent-guide", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
  }));

  app.get("/api/v1/agent/latest", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["window", "mode", "category", "limit"]);
    const p = { ...listParams(q), mode: enumParam(q.mode, "mode", ["selected", "all"] as const, "selected") };
    const res = await v1Items({ ...p, by: "timeline", q: null, cursor: null });
    return markdown(req, reply, latestAnswer(res, p), "agent-latest", V1_CACHE_CONTROL.items);
  }));

  app.get("/api/v1/agent/search", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["q", "window", "category", "limit"]);
    const text = (q.q ?? "").trim();
    if ([...text].length < 2 || [...text].length > 200) throw new QueryError("q must contain 2 to 200 characters.");
    const p = { ...listParams(q), window: enumParam(q.window, "window", ["24h", "7d"] as const, "7d") };
    const found = await searchItems(text, p.window, p.category, p.limit);
    return markdown(req, reply, searchAnswer(found, { q: text, window: p.window, category: p.category }), "agent-search", V1_CACHE_CONTROL.items);
  }));

  app.get("/api/v1/agent/hot", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["limit"]);
    return markdown(req, reply, hotAnswer(await v1HotTopics(), intParam(q.limit, "limit", 1, 10, 10), "http"), "agent-hot", V1_CACHE_CONTROL.hotTopics);
  }));

  app.get("/api/v1/agent/stories/:publicId", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["limit"]);
    const limit = intParam(q.limit, "limit", 1, 50, 20);
    const publicId = (req.params as { publicId: string }).publicId;
    if (publicId.length > 128) throw new QueryError("publicId must be a short opaque id.");
    let found = await resolveStory(publicId);
    if (found.kind === "merged") found = await resolveStory(found.target);
    const body = found.kind === "found" ? await v1Story(found.storyId) : null;
    if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个公开事件。只使用热点结果里给出的「来龙去脉」地址，不要猜。", cacheControl: "public, max-age=60" });
    return markdown(req, reply, storyAnswer(body.story, limit, "http"), "agent-story", V1_CACHE_CONTROL.storyByPublicId);
  }));

  app.get("/api/v1/agent/daily", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const res = await v1Daily("latest");
    if (!res) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "还没有发布过日报。" });
    return markdown(req, reply, dailyAnswer(res.report, "http"), "agent-daily", V1_CACHE_CONTROL.latestDaily);
  }));

  app.get("/api/v1/agent/daily/:date", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const date = (req.params as { date: string }).date;
    if (!isValidDate(date)) throw new QueryError("date must be a real YYYY-MM-DD calendar date.");
    const res = await v1Daily(date);
    if (!res) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `没有 ${date} 的日报；不要换一天冒充。`, cacheControl: "public, max-age=60" });
    return markdown(req, reply, dailyAnswer(res.report, "http"), "agent-daily", V1_CACHE_CONTROL.dailyByDate);
  }));

  if (FEATURES.codexResetMonitor) app.get("/api/v1/agent/codex-resets", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    return markdown(req, reply, codexAnswer(await codexResetPage()), "agent-codex", V1_CACHE_CONTROL.codexResets);
  }));
}
