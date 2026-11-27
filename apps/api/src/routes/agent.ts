// /api/v1/agent: Markdown answers for AI agents. They render with the same functions as the MCP tools;
// errors are the usual v1 Problem JSON. New abilities become new addresses listed in the guide, which
// agents read without updating. On a site with an English edition the engine's answers take lang=en; the
// modules' abilities answer in Chinese only and refuse it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Locale } from "@aihot/contracts/i18n";
import { isReportKey, REPORT_NAMES, REPORT_NAMES_EN } from "@aihot/contracts/reports";
import { PUBLIC_API_CATEGORY_KEYS, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { AGENT_ITEM_LIMIT, agentGuide, dailyAnswer, hotAnswer, latestAnswer, periodAnswer, searchAnswer, searchItems, storyAnswer } from "@aihot/backend/publication/agent";
import { v1Items } from "@aihot/backend/publication/v1";
import { resolveStory, v1HotTopics, v1Story } from "@aihot/backend/publication/stories";
import { dailyWithNotes, v1Period } from "@aihot/backend/publication/reports";
import * as english from "@aihot/backend/publication/english";
import { serverModules } from "@aihot/backend/modules";
import { QueryError, sendProblem, sendTextWithEtag, strictQuery } from "../http/respond.ts";
import { enumParam, inLanguage, intParam, LANG, publicHandler, readerQuery, V1_OPERATIONS } from "./v1.ts";

/** Query keys and Cache-Control for each built-in /api/v1/agent operation (checked against OpenAPI). */
export const AGENT_OPERATIONS = {
  guide: { path: "/api/v1/agent", queryKeys: LANG, cacheControl: "public, max-age=300, must-revalidate" },
  latest: { path: "/api/v1/agent/latest", queryKeys: ["window", "mode", "category", "limit", ...LANG] as readonly string[], cacheControl: V1_OPERATIONS.items.cacheControl },
  search: { path: "/api/v1/agent/search", queryKeys: ["q", "window", "category", "limit", ...LANG] as readonly string[], cacheControl: V1_OPERATIONS.items.cacheControl },
  hot: { path: "/api/v1/agent/hot", queryKeys: ["limit", ...LANG] as readonly string[], cacheControl: V1_OPERATIONS.hotTopics.cacheControl },
  storyByPublicId: { path: "/api/v1/agent/stories/{publicId}", queryKeys: ["limit", ...LANG] as readonly string[], cacheControl: V1_OPERATIONS.storyByPublicId.cacheControl },
  latestDaily: { path: "/api/v1/agent/daily", queryKeys: LANG, cacheControl: V1_OPERATIONS.latestDaily.cacheControl },
  dailyByDate: { path: "/api/v1/agent/daily/{date}", queryKeys: LANG, cacheControl: V1_OPERATIONS.dailyByDate.cacheControl },
  latestWeekly: { path: "/api/v1/agent/weekly", queryKeys: LANG, cacheControl: V1_OPERATIONS.latestWeekly.cacheControl },
  weeklyByWeek: { path: "/api/v1/agent/weekly/{week}", queryKeys: LANG, cacheControl: V1_OPERATIONS.weeklyByWeek.cacheControl },
  latestMonthly: { path: "/api/v1/agent/monthly", queryKeys: LANG, cacheControl: V1_OPERATIONS.latestMonthly.cacheControl },
  monthlyByMonth: { path: "/api/v1/agent/monthly/{month}", queryKeys: LANG, cacheControl: V1_OPERATIONS.monthlyByMonth.cacheControl },
} as const;

function markdown(req: FastifyRequest, reply: FastifyReply, text: string, etagPrefix: string, cacheControl: string) {
  return sendTextWithEtag(req, reply, text, { etagPrefix, cacheControl, contentType: "text/markdown; charset=utf-8" });
}

/** A daily's Agent answer in the asked language: the issue and its entries' notes. */
async function dailyText(res: NonNullable<Awaited<ReturnType<typeof dailyWithNotes>>>, lang: Locale) {
  const daily = await inLanguage(res, english.v1DailyWithNotes("text"), lang);
  return dailyAnswer(daily.body.report, "http", daily.notes, daily.leadItemId, lang);
}

function listParams(q: Record<string, string>) {
  return {
    window: enumParam(q.window, "window", ["24h", "7d"] as const, "24h"),
    category: q.category === undefined ? null : enumParam<PublicApiCategoryKey>(q.category, "category", PUBLIC_API_CATEGORY_KEYS, PUBLIC_API_CATEGORY_KEYS[0]),
    limit: intParam(q.limit, "limit", 1, AGENT_ITEM_LIMIT.max, AGENT_ITEM_LIMIT.default),
  };
}

export function registerAgent(app: FastifyInstance) {
  app.get("/api/v1/agent", publicHandler(async (req, reply) => {
    const { lang } = readerQuery(req, AGENT_OPERATIONS.guide.queryKeys);
    // Cached like /openapi-v1.json: agents learn a new ability within minutes of its release.
    return markdown(req, reply, agentGuide(lang), "agent-guide", AGENT_OPERATIONS.guide.cacheControl);
  }));

  app.get("/api/v1/agent/latest", publicHandler(async (req, reply) => {
    const { q, lang } = readerQuery(req, AGENT_OPERATIONS.latest.queryKeys);
    const p = { ...listParams(q), mode: enumParam(q.mode, "mode", ["selected", "all"] as const, "selected") };
    const res = await inLanguage(await v1Items({ ...p, by: "timeline", q: null, cursor: null }), english.v1Items("text"), lang);
    return markdown(req, reply, latestAnswer(res, p, lang), "agent-latest", AGENT_OPERATIONS.latest.cacheControl);
  }));

  app.get("/api/v1/agent/search", publicHandler(async (req, reply) => {
    const { q, lang } = readerQuery(req, AGENT_OPERATIONS.search.queryKeys);
    const text = (q.q ?? "").trim();
    if ([...text].length < 2 || [...text].length > 200) throw new QueryError("q must contain 2 to 200 characters.");
    const p = { ...listParams(q), window: enumParam(q.window, "window", ["24h", "7d"] as const, "7d") };
    const found = await searchItems(text, p.window, p.category, p.limit);
    const res = await inLanguage(found.res, english.v1Items("text"), lang);
    return markdown(req, reply, searchAnswer({ ...found, res }, { q: text, window: p.window, category: p.category }, lang), "agent-search", AGENT_OPERATIONS.search.cacheControl);
  }));

  app.get("/api/v1/agent/hot", publicHandler(async (req, reply) => {
    const { q, lang } = readerQuery(req, AGENT_OPERATIONS.hot.queryKeys);
    const hot = await inLanguage(await v1HotTopics(), english.v1Hot("text"), lang);
    return markdown(req, reply, hotAnswer(hot, intParam(q.limit, "limit", 1, 10, 10), "http", lang), "agent-hot", AGENT_OPERATIONS.hot.cacheControl);
  }));

  app.get("/api/v1/agent/stories/:publicId", publicHandler(async (req, reply) => {
    const { q, lang } = readerQuery(req, AGENT_OPERATIONS.storyByPublicId.queryKeys);
    const limit = intParam(q.limit, "limit", 1, 50, 20);
    const publicId = (req.params as { publicId: string }).publicId;
    if (publicId.length > 128) throw new QueryError("publicId must be a short opaque id.");
    const found = await resolveStory(publicId);
    const body = found.kind !== "not_found" ? await v1Story(found.storyId) : null;
    if (!body) {
      const detail = lang === "en" ? "No such public story. Only use the “Full story” addresses the trending results give; don't guess." : "没有这个公开事件。只使用热点结果里给出的「来龙去脉」地址，不要猜。";
      return sendProblem(req, reply, { status: 404, code: "not_found", detail, cacheControl: "public, max-age=60" });
    }
    const story = (await inLanguage(body, english.v1StoryAnswer("text"), lang)).story;
    return markdown(req, reply, storyAnswer(story, limit, "http", lang), "agent-story", AGENT_OPERATIONS.storyByPublicId.cacheControl);
  }));

  app.get("/api/v1/agent/daily", publicHandler(async (req, reply) => {
    const { lang } = readerQuery(req, AGENT_OPERATIONS.latestDaily.queryKeys);
    const res = await dailyWithNotes("latest");
    if (!res) return sendProblem(req, reply, { status: 404, code: "not_found", detail: lang === "en" ? "No daily has been published yet." : "还没有发布过日报。" });
    return markdown(req, reply, await dailyText(res, lang), "agent-daily", AGENT_OPERATIONS.latestDaily.cacheControl);
  }));

  app.get("/api/v1/agent/daily/:date", publicHandler(async (req, reply) => {
    const { lang } = readerQuery(req, AGENT_OPERATIONS.dailyByDate.queryKeys);
    const date = (req.params as { date: string }).date;
    if (!isReportKey("daily", date)) throw new QueryError("date must be a real YYYY-MM-DD calendar date.");
    const res = await dailyWithNotes(date);
    if (!res) {
      const detail = lang === "en" ? `There is no daily for ${date}; don't pass off another day's.` : `没有 ${date} 的日报；不要换一天冒充。`;
      return sendProblem(req, reply, { status: 404, code: "not_found", detail, cacheControl: "public, max-age=60" });
    }
    return markdown(req, reply, await dailyText(res, lang), "agent-daily", AGENT_OPERATIONS.dailyByDate.cacheControl);
  }));

  for (const p of [
    { kind: "weekly", param: "week", form: "a real ISO week such as 2026-W39", latest: AGENT_OPERATIONS.latestWeekly, byKey: AGENT_OPERATIONS.weeklyByWeek },
    { kind: "monthly", param: "month", form: "a real month such as 2026-09", latest: AGENT_OPERATIONS.latestMonthly, byKey: AGENT_OPERATIONS.monthlyByMonth },
  ] as const) {
    const nameEn = REPORT_NAMES_EN[p.kind].toLowerCase();
    app.get(`/api/v1/agent/${p.kind}`, publicHandler(async (req, reply) => {
      const { lang } = readerQuery(req, p.latest.queryKeys);
      const body = await v1Period(p.kind, "latest");
      if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: lang === "en" ? `No ${nameEn} has been published yet.` : `还没有发布过${REPORT_NAMES[p.kind]}。` });
      const report = (await inLanguage(body, english.v1PeriodAnswer(p.kind, "text"), lang)).report;
      return markdown(req, reply, periodAnswer(report, p.kind, "http", lang), `agent-${p.kind}`, p.latest.cacheControl);
    }));
    app.get(`/api/v1/agent/${p.kind}/:${p.param}`, publicHandler(async (req, reply) => {
      const { lang } = readerQuery(req, p.byKey.queryKeys);
      const key = (req.params as Record<string, string>)[p.param]!;
      if (!isReportKey(p.kind, key)) throw new QueryError(`${p.param} must be ${p.form}.`);
      const body = await v1Period(p.kind, key);
      if (!body) {
        const detail = lang === "en" ? `There is no ${nameEn} for ${key}; don't pass off another issue.` : `没有 ${key} 的${REPORT_NAMES[p.kind]}；不要换一期冒充。`;
        return sendProblem(req, reply, { status: 404, code: "not_found", detail, cacheControl: "public, max-age=60" });
      }
      const report = (await inLanguage(body, english.v1PeriodAnswer(p.kind, "text"), lang)).report;
      return markdown(req, reply, periodAnswer(report, p.kind, "http", lang), `agent-${p.kind}`, p.byKey.cacheControl);
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
