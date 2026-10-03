// /api/v1/agent: Markdown answers for AI agents. They render with the same functions as the MCP tools;
// errors are the usual v1 Problem JSON. New abilities become new addresses listed in the guide, which
// agents read without updating.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PUBLIC_API_CATEGORY_KEYS, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { isValidDate } from "@aihot/contracts/time";
import { agentGuide, dailyAnswer, hotAnswer, latestAnswer, periodAnswer, searchAnswer, searchItems, storyAnswer } from "@aihot/backend/publication/agent";
import { v1Items } from "@aihot/backend/publication/v1";
import { resolveStory, v1HotTopics, v1Story } from "@aihot/backend/publication/stories";
import { dailyWithNotes, isPeriodKey, v1Period } from "@aihot/backend/publication/reports";
import { requestNotice, serverModules } from "@aihot/backend/modules";
import { QueryError, sendProblem, sendTextWithEtag, strictQuery } from "../http/respond.ts";
import { enumParam, intParam, publicHandler, V1_OPERATIONS } from "./v1.ts";

function markdown(req: FastifyRequest, reply: FastifyReply, text: string, etagPrefix: string, cacheControl: string) {
  // A module's reminder for the person behind the request closes the answer.
  const note = requestNotice("agent", req);
  if (note) text += note;
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
    // Cached like /openapi-v1.json: agents learn a new ability within minutes of its release.
    return markdown(req, reply, agentGuide(), "agent-guide", "public, max-age=300, stale-while-revalidate=3600");
  }));

  app.get("/api/v1/agent/latest", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["window", "mode", "category", "limit"]);
    const p = { ...listParams(q), mode: enumParam(q.mode, "mode", ["selected", "all"] as const, "selected") };
    const res = await v1Items({ ...p, by: "timeline", q: null, cursor: null });
    return markdown(req, reply, latestAnswer(res, p), "agent-latest", V1_OPERATIONS.items.cacheControl);
  }));

  app.get("/api/v1/agent/search", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["q", "window", "category", "limit"]);
    const text = (q.q ?? "").trim();
    if ([...text].length < 2 || [...text].length > 200) throw new QueryError("q must contain 2 to 200 characters.");
    const p = { ...listParams(q), window: enumParam(q.window, "window", ["24h", "7d"] as const, "7d") };
    const found = await searchItems(text, p.window, p.category, p.limit);
    return markdown(req, reply, searchAnswer(found, { q: text, window: p.window, category: p.category }), "agent-search", V1_OPERATIONS.items.cacheControl);
  }));

  app.get("/api/v1/agent/hot", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["limit"]);
    return markdown(req, reply, hotAnswer(await v1HotTopics(), intParam(q.limit, "limit", 1, 10, 10), "http"), "agent-hot", V1_OPERATIONS.hotTopics.cacheControl);
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
    return markdown(req, reply, storyAnswer(body.story, limit, "http"), "agent-story", V1_OPERATIONS.storyByPublicId.cacheControl);
  }));

  app.get("/api/v1/agent/daily", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const res = await dailyWithNotes("latest");
    if (!res) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "还没有发布过日报。" });
    return markdown(req, reply, dailyAnswer(res.body.report, "http", res.notes), "agent-daily", V1_OPERATIONS.latestDaily.cacheControl);
  }));

  app.get("/api/v1/agent/daily/:date", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const date = (req.params as { date: string }).date;
    if (!isValidDate(date)) throw new QueryError("date must be a real YYYY-MM-DD calendar date.");
    const res = await dailyWithNotes(date);
    if (!res) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `没有 ${date} 的日报；不要换一天冒充。`, cacheControl: "public, max-age=60" });
    return markdown(req, reply, dailyAnswer(res.body.report, "http", res.notes), "agent-daily", V1_OPERATIONS.dailyByDate.cacheControl);
  }));

  for (const p of [
    { kind: "weekly", name: "周报", param: "week", form: "a real ISO week such as 2026-W39", latest: V1_OPERATIONS.latestWeekly.cacheControl, byKey: V1_OPERATIONS.weeklyByWeek.cacheControl },
    { kind: "monthly", name: "月报", param: "month", form: "a real month such as 2026-09", latest: V1_OPERATIONS.latestMonthly.cacheControl, byKey: V1_OPERATIONS.monthlyByMonth.cacheControl },
  ] as const) {
    app.get(`/api/v1/agent/${p.kind}`, publicHandler(async (req, reply) => {
      strictQuery(req, []);
      const body = await v1Period(p.kind, "latest");
      if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `还没有发布过${p.name}。` });
      return markdown(req, reply, periodAnswer(body.report, p.kind, "http"), `agent-${p.kind}`, p.latest);
    }));
    app.get(`/api/v1/agent/${p.kind}/:${p.param}`, publicHandler(async (req, reply) => {
      strictQuery(req, []);
      const key = (req.params as Record<string, string>)[p.param]!;
      if (!isPeriodKey(p.kind, key)) throw new QueryError(`${p.param} must be ${p.form}.`);
      const body = await v1Period(p.kind, key);
      if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: `没有 ${key} 的${p.name}；不要换一期冒充。`, cacheControl: "public, max-age=60" });
      return markdown(req, reply, periodAnswer(body.report, p.kind, "http"), `agent-${p.kind}`, p.byKey);
    }));
  }
  // The modules' abilities, each answered at its own address.
  for (const ability of serverModules().flatMap((m) => m.agent?.abilities ?? [])) {
    app.get(`/api/v1/agent${ability.path}`, publicHandler(async (req, reply) => {
      strictQuery(req, []);
      return markdown(req, reply, await ability.answer(), ability.etagPrefix, ability.cacheControl);
    }));
  }
}
