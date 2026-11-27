// RSS feeds. GUID = article id (isPermaLink=false), <link> = the site's page, pubDate = source
// publication time (none when it is unknown). Summary feeds never carry content:encoded; full feeds
// inline bodies only for sources that explicitly allow redistribution. Titles come from the site's
// name and categories. On a site with an English edition every feed is also at /en/feed…, in English and
// linking to the English pages: an article enters it once its title and summary are in English, an issue once
// its headline and lead are (with the entries already in English); a full feed carries the original text there
// (a body written in Chinese, none).
import { inLanguage, L, type Locale } from "@aihot/contracts/i18n";
import { ENGLISH, needsEnglish } from "@aihot/contracts/english";
import { REPORT_NAMES, REPORT_NAMES_EN } from "@aihot/contracts/site";
import { feedCategoryLabelIn, PUBLIC_API_CATEGORY_KEYS, toPublicApiCategory, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { EDITION_WHEN, REPORTS, SITE, subjectAfter } from "@aihot/site";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { escapeXml } from "../lib/text.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { withCover, type Cover } from "../content/cover.ts";
import { feedIssues, type FeedIssue, type ReportKind } from "./reports.ts";
import { textToHtml } from "../content/sanitize.ts";
import { isChineseText } from "../lib/text.ts";
import * as english from "./english.ts";
import { xArticleBody } from "../content/posts.ts";
import { PUBLIC_ITEM_COLUMNS, publicCategoryCondition, exportTranslation, xView, type ItemRow } from "./items.ts";
import { publicSourceName } from "./rules.ts";
import { browsedCondition, seatedCondition } from "./scope.ts";
import { siteUrl } from "./links.ts";

/** A feed's language: Chinese at /feed…, English at /en/feed… (on a site with an English edition). */
export type FeedLanguage = Locale;

const ITEMS_KEPT = 50;
const ISSUES_KEPT: Record<ReportKind, number> = { daily: 30, weekly: 12, monthly: 12 };
const when = ENGLISH?.editionWhen ?? { daily: "daily", weekly: "weekly", monthly: "monthly" };

const FEEDS = {
  "selected": {
    path: "/feed.xml", homePath: "/", pollHintMinutes: 30,
    title: L(`${SITE.name} — 精选`, `${SITE.name} — Top Picks`),
    description: L(
      `最新 ${ITEMS_KEPT} 条 ${SITE.name} 精选摘要，附站内阅读与原文链接；想在阅读器里直接看全文，可改订 /feed/full.xml。`,
      `The latest ${ITEMS_KEPT} ${SITE.name} top picks in English, with links to read them on the site and at the source; for full text in your reader, subscribe to /en/feed/full.xml instead.`,
    ),
  },
  "selected-full": {
    path: "/feed/full.xml", homePath: "/", pollHintMinutes: 30,
    title: L(`${SITE.name} — 精选全文`, `${SITE.name} — Top Picks, Full Text`),
    description: L(
      `最新 ${ITEMS_KEPT} 条 ${SITE.name} 精选；允许转载的来源会直接附上全文，其余提供摘要与阅读链接。`,
      `The latest ${ITEMS_KEPT} ${SITE.name} top picks in English; sources that allow republishing come with their original full text (not those written in Chinese), the rest with a summary and links.`,
    ),
  },
  "all": {
    path: "/feed/all.xml", homePath: "/all", pollHintMinutes: 30,
    title: L(`${SITE.name} — ${subjectAfter("全部", "动态")}`, `${SITE.name} — All ${SITE.subject} News`),
    description: L(
      `${subjectAfter("最近 7 天发布的", "动态")}，按发布时间倒序，已过滤重复和低价值内容。`,
      `${SITE.subject} news from the last 7 days in English, newest first, with duplicates and low-value items filtered out.`,
    ),
  },
  "daily": {
    path: "/feed/daily.xml", homePath: "/daily", pollHintMinutes: 30,
    title: L(`${SITE.name} ${REPORT_NAMES.daily}`, `${SITE.name} ${REPORT_NAMES_EN.daily}`),
    description: L(
      `${SITE.name} ${EDITION_WHEN.daily}（北京时间）发布的精编日报，保留最近 ${ISSUES_KEPT.daily} 期。`,
      `${SITE.name}'s daily briefing, out ${when.daily}; the last ${ISSUES_KEPT.daily} issues.`,
    ),
  },
  "weekly": {
    path: "/feed/weekly.xml", homePath: "/weekly", pollHintMinutes: 180,
    title: L(`${SITE.name} ${REPORT_NAMES.weekly}`, `${SITE.name} ${REPORT_NAMES_EN.weekly}`),
    description: L(
      `${SITE.name} ${EDITION_WHEN.weekly}（北京时间）发布的周报：整理自上周日报的${REPORTS.entry.noun}，按栏目归类并附总述，保留最近 ${ISSUES_KEPT.weekly} 期。`,
      `${SITE.name}'s weekly roundup, out ${when.weekly}: last week's daily stories by section, with an overview; the last ${ISSUES_KEPT.weekly} issues.`,
    ),
  },
  "monthly": {
    path: "/feed/monthly.xml", homePath: "/monthly", pollHintMinutes: 360,
    title: L(`${SITE.name} ${REPORT_NAMES.monthly}`, `${SITE.name} ${REPORT_NAMES_EN.monthly}`),
    description: L(
      `${SITE.name} ${EDITION_WHEN.monthly}（北京时间）发布的月报：整理自上月日报的${REPORTS.entry.noun}，按栏目归类并附总述，保留最近 ${ISSUES_KEPT.monthly} 期。`,
      `${SITE.name}'s monthly review, out ${when.monthly}: last month's daily stories by section, with an overview; the last ${ISSUES_KEPT.monthly} issues.`,
    ),
  },
};

/** A category feed inherits the metadata of the feed it narrows. */
export function feedMeta(id: ItemFeedKind | ReportKind, lang: FeedLanguage = "zh") {
  const meta = FEEDS[id];
  return {
    path: inLanguage(meta.path, lang), homePath: inLanguage(meta.homePath, lang),
    title: meta.title[lang], description: meta.description[lang],
    pollHintMinutes: meta.pollHintMinutes,
  };
}

/** RSS <author> needs an address: a no-reply one on the site's own domain. */
const AUTHOR = `noreply@${new URL(config.siteUrl).hostname}`;

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")}]]>`;
}

function rfc822(d: Date): string {
  return d.toUTCString();
}

function channel(meta: { title: string; description: string; homePath: string; selfPath: string; ttl: number }, items: string[], lang: FeedLanguage): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(meta.title)}</title>
    <link>${escapeXml(siteUrl(meta.homePath))}</link>
    <description>${escapeXml(meta.description)}</description>
    <language>${lang === "en" ? "en" : "zh-CN"}</language>
    <atom:link href="${escapeXml(siteUrl(meta.selfPath))}" rel="self" type="application/rss+xml" />
    <ttl>${meta.ttl}</ttl>
    <generator>${escapeXml(`${SITE.name} (${siteUrl("/agent")})`)}</generator>
${items.join("\n")}
  </channel>
</rss>
`;
}

type FeedRow = Pick<ItemRow, "id" | "title" | "summary" | "url" | "category" | "published_at" | "source_name"> &
  Partial<Pick<ItemRow, "channel" | "x_post" | "x_article" | "zh_text" | "quoted_zh" | "language"> & {
    syndicate: boolean; body_text: string | null; body_html: string | null; cover: Cover | null; tr_html: string | null; tr_complete: boolean | null;
  }>;

/** Readers keep feed items for days: body images in full RSS are signed for a week, not a day. */
const FEED_IMAGE_SECONDS = 7 * 86400;

/**
 * The body a full feed carries, in Chinese when the page has it: an X post's translation (with the post
 * it quotes, translated too), else a complete Chinese translation of the article, else the original. In
 * English, the original, unless it is written in Chinese (then none). It ends with an attribution line (also
 * a mark on copies taken from the feed).
 */
function fullContent(r: FeedRow, aihot: string, lang: FeedLanguage): string | null {
  const en = lang === "en";
  let html: string | null = null;
  const x = r.channel === "x" ? xView({ x_post: r.x_post ?? null, x_article: r.x_article ?? null, zh_text: r.zh_text ?? null, quoted_zh: r.quoted_zh ?? null }) : null;
  if (x) {
    // A long X Article as its page shows it (after what the post says besides its link), in Chinese when
    // its translation is complete, as an article's body is.
    const article = r.x_article?.html;
    html = article
      ? (en ? null : exportTranslation({ language: r.language, body_text: r.x_article?.text ?? "", tr_html: r.tr_html, tr_complete: r.tr_complete })) ?? xArticleBody(String(r.x_post?.text ?? ""), article)
      : textToHtml(en ? x.text : x.translation ?? x.text);
    if (x.quoted?.text && !(en && isChineseText(x.quoted.text))) {
      const quoted = en ? x.quoted.text : x.quoted.translation ?? x.quoted.text;
      html += `<blockquote><p>${en ? "Quoting" : "引用"} @${escapeXml(x.quoted.handle)}${en ? ":" : "："}</p>${textToHtml(quoted)}${x.quoted.url ? `<p><a href="${escapeXml(x.quoted.url)}">${escapeXml(x.quoted.url)}</a></p>` : ""}</blockquote>`;
    }
    for (const media of r.x_post?.media ?? []) {
      const url = String(media.url ?? "");
      if (!/^https?:\/\//i.test(url)) continue;
      html += media.kind === "video"
        ? `<p><a href="${escapeXml(url)}">${en ? "Video" : "视频"}</a></p>`
        : `<p><img src="${escapeXml(url)}" alt="${escapeXml(String(media.alt ?? ""))}"></p>`;
    }
  } else if (r.body_html) {
    html = withCover((en ? null : exportTranslation(r)) ?? r.body_html, r.cover, r.body_html);
  }
  if (!html) return null;
  // In English, a body written in Chinese is not carried: judged by its words, as a declared language can be wrong.
  if (en && isChineseText(html.replace(/<[^>]+>/g, " "))) return null;
  const credit = en
    ? `<p>— Collected by ${escapeXml(SITE.name)}; the full page and more ${escapeXml(SITE.subject)} news at <a href="${aihot}">${aihot}</a></p>`
    : `<p>—— 本文由 ${escapeXml(SITE.name)} 聚合整理，完整版与${escapeXml(subjectAfter("更多", "动态"))}见 <a href="${aihot}">${aihot}</a></p>`;
  return `${proxyBodyImages(html, true, FEED_IMAGE_SECONDS)}${credit}`;
}

function itemXml(r: FeedRow, includeContent: boolean, lang: FeedLanguage): string {
  const aihot = siteUrl(inLanguage(`/items/${r.id}`, lang));
  const summary = r.summary ?? "";
  const description = `<p>${escapeXml(summary)}</p>\n<p>🔗 <a href="${escapeXml(r.url)}">${lang === "en" ? "Read the original" : "阅读原文"}</a></p>\n<p>via ${escapeXml(SITE.name)} · <a href="${aihot}">${aihot}</a></p>`;
  const publicCategory = toPublicApiCategory(r.category);
  const category = publicCategory ? `\n      <category>${escapeXml(feedCategoryLabelIn(publicCategory, lang))}</category>` : "";
  let content = "";
  if (includeContent && r.syndicate) {
    const html = fullContent(r, aihot, lang);
    if (html) content = `\n      <content:encoded>${cdata(html)}</content:encoded>`;
  }
  const pubDate = r.published_at ? `\n      <pubDate>${rfc822(r.published_at)}</pubDate>` : "";
  return `    <item>
      <title>${cdata(r.title)}</title>
      <link>${aihot}</link>
      <description>${cdata(description)}</description>${content}${category}${pubDate}
      <guid isPermaLink="false">${escapeXml(r.id)}</guid>
      <author>${escapeXml(AUTHOR)} (${escapeXml(r.source_name)})</author>
    </item>`;
}

/** An English feed's articles as the English pages show them: the title and summary together, the source's name. */
const feedRows: english.Overlay<FeedRow[]> = (rows, c) => rows.map((r) => {
  const [title, summary] = c.all([["headline", r.title], ["text", r.summary]]);
  return { ...r, title, summary, source_name: c.one("name", r.source_name) };
});

export type ItemFeedKind = "selected" | "selected-full" | "all";

// Items are the newest by their original publish time (the pubDate shown): 50 per feed; a category
// feed holds only its last 7 days (by original publish time).

export async function itemFeed(kind: ItemFeedKind, category: PublicApiCategoryKey | null, { now = new Date(), lang = "zh" }: { now?: Date; lang?: FeedLanguage } = {}): Promise<string> {
  const includeContent = kind === "selected-full";
  const scope = kind === "all"
    ? sql`${browsedCondition(now)} AND coalesce(p.published_at, p.discovered_at) > ${now}::timestamptz - interval '7 days'
        AND coalesce(p.published_at, p.discovered_at) <= ${now}`
    : sql`${seatedCondition(now)} ${publicCategoryCondition(category)}
        ${category ? sql`AND coalesce(p.published_at, p.discovered_at) >= ${new Date(now.getTime() - 7 * 86400_000)}` : sql``}`;
  const rows = await sql<FeedRow[]>`
    WITH page AS MATERIALIZED (
      SELECT p.article_id FROM publications p WHERE ${scope}
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC LIMIT ${ITEMS_KEPT}
    )
    SELECT ${PUBLIC_ITEM_COLUMNS}
      ${includeContent ? sql`, p.channel, p.syndicate, a.language, a.x_post, a.x_article,
        CASE WHEN p.channel = 'x' THEN tr.body_text END AS zh_text, qt.text_zh AS quoted_zh,
        a.body_text, a.body_html, a.cover, tr.body_html AS tr_html, tr.complete AS tr_complete` : sql``}
    FROM page JOIN publications p ON p.article_id = page.article_id JOIN sources s ON s.id = p.source_id
    ${includeContent ? sql`LEFT JOIN articles a ON a.id = p.article_id AND p.syndicate
      LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision
      LEFT JOIN quote_translations qt ON p.channel = 'x' AND qt.tweet_id = coalesce(a.x_post->'quoted'->>'tweetId', substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)'))` : sql``}
    ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC`;
  const named = rows.map((r) => ({ ...r, source_name: publicSourceName(r.source_name) }));
  // In English, an article whose title or summary is not yet is left out.
  const shown = lang === "en" ? (await english.inEnglish(named, feedRows)).filter((r) => !needsEnglish(r.title) && !needsEnglish(r.summary)) : named;
  const m = feedMeta(kind, lang);
  let meta = { title: m.title, description: m.description, homePath: m.homePath, selfPath: m.path, ttl: m.pollHintMinutes };
  if (category) {
    const label = feedCategoryLabelIn(category, lang);
    const selfPath = inLanguage(includeContent ? `/feed/full/category/${category}.xml` : `/feed/category/${category}.xml`, lang);
    meta = lang === "en"
      ? {
        title: includeContent ? `${SITE.name} — ${label}, Full Text` : `${SITE.name} — ${label}`,
        description: includeContent
          ? `${SITE.name} top picks in ${label}, in English: sources that allow republishing come with their original full text (not those written in Chinese), the rest with a summary and links.`
          : `${SITE.name} top picks in ${label}, in English, for following just what you care about.`,
        homePath: inLanguage("/", "en"), selfPath, ttl: m.pollHintMinutes,
      }
      : {
        title: includeContent ? `${SITE.name} — ${label}全文` : `${SITE.name} — ${label}`,
        description: includeContent
          ? `${SITE.name}「${label}」分类精选：允许转载的来源直接附上全文，其余提供摘要与阅读链接。`
          : `${SITE.name}「${label}」分类精选摘要，方便只订阅自己关心的方向。`,
        homePath: "/", selfPath, ttl: m.pollHintMinutes,
      };
  }
  const items = shown.map((r) => itemXml(r, includeContent, lang));
  return channel(meta, items, lang);
}

/** One issue: its headline, its lead (a weekly's or monthly's overview) and its contents, each entry linking to its page. */
function issueXml(kind: ReportKind, r: FeedIssue, lang: FeedLanguage): string {
  const url = siteUrl(inLanguage(`/${kind}/${r.key}`, lang));
  const name = `${SITE.name} ${lang === "en" ? REPORT_NAMES_EN[kind] : REPORT_NAMES[kind]}`;
  const title = r.headline ? `${name} · ${r.key} — ${r.headline}` : `${name} · ${r.key}`;
  const link = (id: string) => siteUrl(inLanguage(`/items/${id}`, lang));
  const contents = r.sections.map((s) => `<p><strong>${escapeXml(s.label)}</strong></p>\n<ul>${s.items.map((i) => `<li><a href="${escapeXml(link(i.id))}">${escapeXml(i.title)}</a></li>`).join("")}</ul>`);
  const description = [`<p>${escapeXml(r.leadParagraph ?? r.headline ?? "")}</p>`, ...contents, `<p>via ${escapeXml(SITE.name)} · <a href="${url}">${url}</a></p>`].join("\n");
  return `    <item>
      <title>${cdata(title)}</title>
      <link>${url}</link>
      <description>${cdata(description)}</description>
      <pubDate>${rfc822(r.generatedAt)}</pubDate>
      <guid isPermaLink="false">${kind}-${escapeXml(r.key)}</guid>
      <author>${escapeXml(AUTHOR)} (${escapeXml(SITE.name)})</author>
    </item>`;
}

/** The daily, weekly or monthly feed: one item per issue, newest first. */
export async function reportFeed(kind: ReportKind, lang: FeedLanguage = "zh"): Promise<string> {
  const m = feedMeta(kind, lang);
  const meta = { title: m.title, description: m.description, homePath: m.homePath, selfPath: m.path, ttl: m.pollHintMinutes };
  let issues = await feedIssues(kind, ISSUES_KEPT[kind]);
  if (lang === "en") {
    // An issue enters once its headline and lead are in English; an entry or section still in Chinese waits.
    issues = (await english.inEnglish(issues, english.feedIssues(kind)))
      .filter((r) => !needsEnglish(r.headline) && !needsEnglish(r.leadParagraph))
      .map((r) => ({
        ...r,
        sections: r.sections.filter((s) => !needsEnglish(s.label))
          .map((s) => ({ ...s, items: s.items.filter((i) => !needsEnglish(i.title)) })).filter((s) => s.items.length > 0),
      }));
  }
  return channel(meta, issues.map((r) => issueXml(kind, r, lang)), lang);
}

export function isFeedCategory(v: string): v is PublicApiCategoryKey {
  return (PUBLIC_API_CATEGORY_KEYS as readonly string[]).includes(v);
}
