// Share images (1200×630 PNG) for pages, items, reports, topics and events. Only public content
// gets a card; anything else is a real 404. On a site with an English edition every card is also
// drawn in English under /og/en/…, for the English pages: the language is in the path, as a CDN may
// keep one copy of an image whatever its query.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ENGLISH, READER_LANGUAGES, WAITING_ENGLISH_SECONDS, needsEnglish } from "@aihot/contracts/english";
import { namesEn, type Locale } from "@aihot/contracts/i18n";
import { REPORT_NAMES_EN, reportDateLabel, reportDateLabelEn } from "@aihot/contracts/site";
import { topicDefinition, topicName } from "@aihot/contracts/taxonomy";
import { TOPIC_GROUP_EN } from "@aihot/industry/english";
import * as english from "@aihot/backend/publication/english";
import { loadItemOgCard, loadItemPoster } from "@aihot/backend/publication/og";
import { loadReport, type ReportKind } from "@aihot/backend/publication/reports";
import { findTopic, TOPIC_GROUPS, TOPICS } from "@aihot/backend/publication/topics";
import { loadStoryShare, resolveStory } from "@aihot/backend/publication/stories";
import { ogEtag, renderOg, type OgCard } from "@aihot/backend/media/og";
import { posterEtag, renderPoster } from "@aihot/backend/media/poster";
import { CARDS, REPORTS, SITE, subjectAfter, withSubject } from "@aihot/site";

/** The pages' share cards: the site's texts, and the topic count of the topic list. */
const PAGES: Record<Locale, Record<string, OgCard>> = {
  zh: {
    ...CARDS,
    topics: { kicker: "主题", title: `${TOPICS.length} ${subjectAfter("个长期追踪的", "方向")}`, subtitle: `${TOPIC_GROUPS.map((g) => g.name).join("、")}。` },
  },
  en: Object.fromEntries(Object.entries({
    ...ENGLISH?.cards,
    topics: { kicker: "Topics", title: `${TOPICS.length} ${SITE.subject} topics we follow`, subtitle: `${namesEn(TOPIC_GROUPS.map((g) => TOPIC_GROUP_EN[g.key]?.name ?? g.name))}.` },
  }).map(([name, card]) => [name, { ...card, lang: "en" as const }])),
};

/**
 * Article, event and report images carry editable content. A reader may keep a copy for five
 * minutes; shared caches are refreshed on publication changes. Brand images keep their own lifetime.
 */
const CONTENT_IMAGE_CACHE = "public, max-age=300, s-maxage=3600, must-revalidate";
/** An English card whose words are not all in English yet: kept a minute, so it turns English soon after they are. */
const WAITING_IMAGE_CACHE = `public, max-age=${WAITING_ENGLISH_SECONDS}, s-maxage=${WAITING_ENGLISH_SECONDS}, must-revalidate`;

async function send(req: FastifyRequest, reply: FastifyReply, card: OgCard, maxAge: number, cacheControl = `public, max-age=${maxAge}, s-maxage=${maxAge * 7}, stale-while-revalidate=86400`) {
  const tag = `"og-${ogEtag(card)}"`;
  const waiting = card.lang === "en" && (needsEnglish(card.title) || needsEnglish(card.subtitle));
  reply.header("ETag", tag).header("Cache-Control", waiting ? WAITING_IMAGE_CACHE : cacheControl);
  if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
  return reply.type("image/png").send((await renderOg(card)).png);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).header("Cache-Control", "public, max-age=300").type("text/plain; charset=utf-8").send("Not found");
}

const REPORT_NAMES: Record<ReportKind, string> = { daily: withSubject("日报"), weekly: withSubject("周报"), monthly: withSubject("月报") };

export function registerOg(app: FastifyInstance) {
  for (const lang of READER_LANGUAGES) registerIn(app, lang);
}

function registerIn(app: FastifyInstance, lang: Locale) {
  const og = lang === "en" ? "/og/en" : "/og";
  const en = lang === "en";
  const pages = PAGES[lang];

  app.get(`${og}/site.png`, (req, reply) => send(req, reply, pages.site!, 86400));

  app.get(`${og}/pages/:file`, async (req, reply) => {
    const name = (req.params as { file: string }).file.replace(/\.png$/, "");
    const card = Object.hasOwn(pages, name) ? pages[name] : undefined;
    if (!card || !(req.params as { file: string }).file.endsWith(".png")) return notFound(reply);
    return send(req, reply, card, 86400);
  });

  app.get(`${og}/items/:file`, async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const card = await loadItemOgCard(file.slice(0, -4), lang);
    if (!card) return notFound(reply);
    return send(req, reply, card, 3600, CONTENT_IMAGE_CACHE);
  });

  // Phone share poster for an article (1080×1440), generated on first request and cached by content.
  app.get(`${og}/posters/:file`, async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const poster = await loadItemPoster(file.slice(0, -4), lang);
    if (!poster) return notFound(reply);
    const tag = `"poster-${posterEtag(poster)}"`;
    const waiting = en && (needsEnglish(poster.title) || needsEnglish(poster.summary));
    reply.header("ETag", tag).header("Cache-Control", waiting ? WAITING_IMAGE_CACHE : CONTENT_IMAGE_CACHE);
    if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
    return reply.type("image/png").send((await renderPoster(poster)).png);
  });

  app.get(`${og}/reports/:kind/:file`, async (req, reply) => {
    const { kind, file } = req.params as { kind: string; file: string };
    if (!["daily", "weekly", "monthly"].includes(kind) || !file.endsWith(".png")) return notFound(reply);
    const found = await loadReport(kind as ReportKind, file.slice(0, -4));
    if (!found) return notFound(reply);
    const r = en ? await english.inEnglish(found, english.reportHeading) : found;
    const count = r.sections.reduce((n, s) => n + s.items.length, 0);
    // A quiet day's issue (REPORTS.quiet) has nothing to count.
    if (en) {
      const unit = count === 1 ? ENGLISH!.reports.entry.one : ENGLISH!.reports.shareUnit;
      return send(req, reply, {
        kicker: `${withSubject(REPORT_NAMES_EN[r.kind])} · ${reportDateLabelEn(r.kind, r.key)}`,
        title: r.lead?.title ?? r.title,
        subtitle: r.lead?.leadParagraph ?? r.overview,
        meta: count > 0 ? `${count} ${unit} · ${r.readingMinutes} min read` : null,
        lang: "en",
      }, 3600, CONTENT_IMAGE_CACHE);
    }
    return send(req, reply, {
      kicker: `${REPORT_NAMES[r.kind]} · ${reportDateLabel(r.kind, r.key)}`,
      title: r.lead?.title ?? r.title,
      subtitle: r.lead?.leadParagraph ?? r.overview,
      meta: count > 0 ? `${count} ${REPORTS.shareUnit} · 约 ${r.readingMinutes} 分钟读完` : null,
    }, 3600, CONTENT_IMAGE_CACHE);
  });

  app.get(`${og}/topics/:file`, async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const t = file.endsWith(".png") ? findTopic(file.slice(0, -4)) : null;
    if (!t) return notFound(reply);
    const group = TOPIC_GROUPS.find((g) => g.key === t.group);
    if (en) {
      return send(req, reply, {
        kicker: `Topic · ${TOPIC_GROUP_EN[t.group]?.name ?? group?.name ?? ""}`,
        title: `${topicName(t.slug, t.name, "en")}: the latest`,
        subtitle: topicDefinition(t.slug, t.definition, "en"),
        lang: "en",
      }, 86400);
    }
    return send(req, reply, { kicker: `主题 · ${group?.name ?? ""}`, title: `${t.name} 最新动态`, subtitle: t.definition }, 86400);
  });

  app.get(`${og}/stories/:file`, async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const found = await resolveStory(file.slice(0, -4));
    if (found.kind === "merged") {
      return reply.code(308).header("Location", `${og}/stories/${found.target}.png`).header("Cache-Control", CONTENT_IMAGE_CACHE).send();
    }
    if (found.kind !== "found") return notFound(reply);
    const detail = await loadStoryShare(found.storyId);
    if (!detail) return notFound(reply);
    const s = en ? await english.inEnglish(detail, english.storyHeading) : detail;
    const { rank } = s;
    return send(req, reply, en
      ? {
        kicker: rank ? `No. ${rank} on Trending · Story` : "Story",
        title: s.title,
        subtitle: s.latest ?? s.digest,
        meta: `${s.sourceCount} ${s.sourceCount === 1 ? "source" : "sources"} · ${s.reportCount} ${s.reportCount === 1 ? "report" : "reports"}`,
        accent: rank ? "hot" : "teal",
        lang: "en",
      }
      : {
        kicker: rank ? `热点第 ${rank} 名 · 事件` : "事件",
        title: s.title,
        subtitle: s.latest ?? s.digest,
        meta: `${s.sourceCount} 个来源 · ${s.reportCount} 篇报道`,
        accent: rank ? "hot" : "teal",
      }, 3600, CONTENT_IMAGE_CACHE);
  });
}
