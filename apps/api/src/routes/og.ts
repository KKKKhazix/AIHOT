// Share images (1200×630 PNG) for pages, items, reports, topics and events. Only public content
// gets a card; anything else is a real 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import { loadItemShare } from "@aihot/backend/publication/og";
import { loadReport, type ReportKind } from "@aihot/backend/publication/reports";
import { findTopic, TOPIC_GROUPS, TOPICS } from "@aihot/backend/publication/topics";
import { loadStoryDetail, resolveStory } from "@aihot/backend/publication/stories";
import { ogEtag, renderOg, type OgCard } from "../og/render.ts";
import { posterEtag, renderPoster, type Poster } from "../og/poster.ts";
import { SITE, subjectAfter, withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import { config } from "@aihot/backend/config";

const S = SITE.subject;

const PAGES: Record<string, OgCard> = {
  site: { kicker: SITE.name, title: SITE.tagline, subtitle: SITE.description },
  all: { kicker: `全部${withSubject("动态")}`, title: "所有信源的最新动态，一站看完", subtitle: "按时间汇总各信源的最新动态，可按类别与标签筛选。" },
  hot: { kicker: "热点榜", title: "过去 48 小时，大家在讨论什么", subtitle: "热度指数、趋势与组成热度的公开来源。", accent: "hot" },
  daily: { kicker: withSubject("日报"), title: `每天 8 点，一份读得完的${withSubject("日报")}`, subtitle: `前一天值得关注的${S}动态。` },
  weekly: { kicker: withSubject("周报"), title: "一周大事，一次看清", subtitle: "本周的主线、重要发布与值得回看的讨论。" },
  monthly: { kicker: withSubject("月报"), title: "一个月的变化", subtitle: "月度主线与关键事件回顾。" },
  topics: { kicker: "主题", title: `${TOPICS.length} ${subjectAfter("个长期追踪的", "方向")}`, subtitle: `${TOPIC_GROUPS.map((g) => g.name).join("、")}。` },
  leaderboard: { kicker: "AI 模型排行榜", title: "多家公开评测的共识排名", subtitle: "综合、编程、推理、知识、专业办公；缺测不补零，价格不影响排名。" },
  "codex-reset": { kicker: "Tibo 重置监控", title: "Codex 额度重置什么时候生效", subtitle: "推算的北京时间窗口、适用范围与 Tibo 原话。", accent: "amber" },
  about: { kicker: "关于", title: `关于 ${SITE.name}`, subtitle: SITE.description },
  terms: { kicker: "使用规则", title: `${SITE.name} 使用规则`, subtitle: "网站、API、RSS 与 MCP 的使用范围。" },
  privacy: { kicker: "隐私说明", title: `${SITE.name} 隐私说明`, subtitle: "访问日志、浏览器本地数据与反馈资料的处理方式。" },
  changelog: { kicker: "更新日志", title: `${SITE.name} 更新日志`, subtitle: "功能更新、优化、公告与下线记录。" },
  feedback: { kicker: "反馈", title: "告诉我们哪里可以更好", subtitle: "内容、功能、接入，或来源方的更正与下架请求。" },
  agent: { kicker: "Agent 接入", title: `把 ${SITE.name} 接进你的 Agent`, subtitle: "Markdown、MCP、RSS、API 四种方式，匿名只读，无需 API Key。" },
};

/**
 * Article and event share images carry current content, so shared caches keep them for an hour at most:
 * after a withdrawal or a correction they are gone from any cache within the hour.
 */
const CONTENT_IMAGE_CACHE = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=600";
const CONTENT_IMAGE_ORIGIN_SECONDS = "300";

async function send(req: FastifyRequest, reply: FastifyReply, card: OgCard, maxAge: number, cacheControl = `public, max-age=${maxAge}, s-maxage=${maxAge * 7}, stale-while-revalidate=86400`) {
  const tag = `"og-${ogEtag(card)}"`;
  reply.header("ETag", tag).header("Cache-Control", cacheControl);
  if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
  return reply.type("image/png").send((await renderOg(card)).png);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).header("Cache-Control", "public, max-age=300").type("text/plain; charset=utf-8").send("Not found");
}

const REPORT_NAMES: Record<ReportKind, string> = { daily: withSubject("日报"), weekly: withSubject("周报"), monthly: withSubject("月报") };

export function registerOg(app: FastifyInstance) {
  app.get("/og/site.png", (req, reply) => send(req, reply, PAGES.site!, 86400));

  app.get("/og/pages/:file", async (req, reply) => {
    const name = (req.params as { file: string }).file.replace(/\.png$/, "");
    const card = PAGES[name];
    if (!card || !(req.params as { file: string }).file.endsWith(".png")) return notFound(reply);
    if ((name === "leaderboard" && !FEATURES.leaderboard) || (name === "codex-reset" && !FEATURES.codexResetMonitor)) return notFound(reply);
    return send(req, reply, card, 86400);
  });

  app.get("/og/items/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const d = await loadItemShare(file.slice(0, -4));
    if (!d) return notFound(reply);
    reply.header("X-Accel-Expires", CONTENT_IMAGE_ORIGIN_SECONDS);
    return send(req, reply, {
      kicker: d.category ? CATEGORY_LABELS[d.category] : withSubject("动态"),
      title: d.title,
      subtitle: d.summary,
      meta: `${d.source.name} · ${beijingDate(d.timelineAt)}`,
      badge: d.selected && d.score !== null ? { value: String(Math.round(d.score)), label: "精选评分" } : null,
    }, 3600, CONTENT_IMAGE_CACHE);
  });

  // Phone share poster for an article (1080×1440), generated on first request and cached by content.
  app.get("/og/posters/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const d = await loadItemShare(file.slice(0, -4));
    if (!d) return notFound(reply);
    const poster: Poster = {
      url: `${config.siteUrl}/items/${d.id}`,
      kicker: d.category ? CATEGORY_LABELS[d.category] : withSubject("动态"),
      title: d.title,
      summary: d.summary,
      source: d.source.name,
      date: beijingDate(d.timelineAt),
      score: d.selected ? d.score : null,
    };
    const tag = `"poster-${posterEtag(poster)}"`;
    reply.header("ETag", tag).header("Cache-Control", CONTENT_IMAGE_CACHE).header("X-Accel-Expires", CONTENT_IMAGE_ORIGIN_SECONDS);
    if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
    return reply.type("image/png").send((await renderPoster(poster)).png);
  });

  app.get("/og/reports/:kind/:file", async (req, reply) => {
    const { kind, file } = req.params as { kind: string; file: string };
    if (!["daily", "weekly", "monthly"].includes(kind) || !file.endsWith(".png")) return notFound(reply);
    const r = await loadReport(kind as ReportKind, file.slice(0, -4));
    if (!r) return notFound(reply);
    return send(req, reply, {
      kicker: `${REPORT_NAMES[r.kind]} · ${r.key}`,
      title: r.lead?.title ?? r.title,
      subtitle: r.lead?.leadParagraph ?? r.overview,
      meta: `${r.sections.reduce((n, s) => n + s.items.length, 0)} 条核心新闻 · 约 ${r.readingMinutes} 分钟读完`,
    }, 86400);
  });

  app.get("/og/topics/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const t = file.endsWith(".png") ? findTopic(file.slice(0, -4)) : null;
    if (!t) return notFound(reply);
    return send(req, reply, { kicker: `主题 · ${TOPIC_GROUPS.find((g) => g.key === t.group)?.name ?? ""}`, title: `${t.name} 最新动态`, subtitle: t.definition }, 86400);
  });

  app.get("/og/stories/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const found = await resolveStory(file.slice(0, -4));
    if (found.kind !== "found") return notFound(reply);
    const s = await loadStoryDetail(found.storyId);
    if (!s) return notFound(reply);
    reply.header("X-Accel-Expires", CONTENT_IMAGE_ORIGIN_SECONDS);
    return send(req, reply, {
      kicker: s.whyHot.rank ? `热点第 ${s.whyHot.rank} · 事件` : "事件",
      title: s.title,
      subtitle: s.latest ?? s.digest,
      meta: `${s.sourceCount} 个来源 · ${s.reportCount} 篇报道`,
      accent: s.whyHot.rank ? "hot" : "teal",
    }, 3600, CONTENT_IMAGE_CACHE);
  });
}
