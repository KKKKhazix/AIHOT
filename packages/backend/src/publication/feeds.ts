// RSS feeds. GUID = article id (isPermaLink=false), <link> = the site's page, pubDate = source
// publication time (none when it is unknown). Summary feeds never carry content:encoded; full feeds
// inline bodies only for sources that explicitly allow redistribution. Titles come from the site's
// name and categories.
import { feedCategoryLabel, PUBLIC_API_CATEGORY_KEYS, toPublicApiCategory, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { EDITION_WHEN, FEED_COPY, REPORTS, SITE, subjectAfter } from "@aihot/site";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { escapeXml } from "../lib/text.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { feedIssues, type FeedIssue, type ReportKind } from "./reports.ts";
import { textToHtml } from "../content/sanitize.ts";
import type { FeedNotice } from "../modules.ts";
import { publicCategoryCondition, exportTranslation, xView, type ItemRow } from "./items.ts";
import { publicSourceName } from "./rules.ts";
import { listedCondition, seatedCondition } from "./scope.ts";
import { dailyUrl, itemUrl, periodUrl, siteUrl } from "./links.ts";

interface FeedMeta {
  id: string;
  path: string;
  title: string;
  description: string;
  homePath: string;
  pollHintMinutes: number;
  edgeCacheSeconds: number;
  staleWhileRevalidateSeconds: number;
}

const CACHE = { edgeCacheSeconds: 300, staleWhileRevalidateSeconds: 900 };

/** What the all feed leaves out: what the site names (FEED_COPY), then what the engine always leaves out. */
const LEFT_OUT = [...FEED_COPY.allLeavesOut, "未审内容", "低相关条目", "已合并重复条目"];

const FEEDS: FeedMeta[] = [
  { id: "selected", path: "/feed.xml", title: `${SITE.name} — 精选`, description: `最新 50 条 ${SITE.name} 精选摘要，保留标题、站内阅读与原文入口；需要阅读器内全文可改订 /feed/full.xml。`, homePath: "/", pollHintMinutes: 30, ...CACHE },
  { id: "selected-full", path: "/feed/full.xml", title: `${SITE.name} — 精选全文`, description: "与精选摘要相同的最新 50 条；仅对明确允许再分发的来源内联正文，其余仍提供摘要和阅读入口。", homePath: "/", pollHintMinutes: 30, ...CACHE },
  { id: "all", path: "/feed/all.xml", title: `${SITE.name} — ${subjectAfter("全部", "动态")}`, description: `最近 7 天公开动态，按真实发布时间倒序；不含${LEFT_OUT.slice(0, -1).join("、")}和${LEFT_OUT.at(-1)}。`, homePath: "/all", pollHintMinutes: 30, ...CACHE },
  { id: "daily", path: "/feed/daily.xml", title: `${SITE.name} 日报`, description: `${SITE.name} ${EDITION_WHEN.daily} 北京时间发布的精编日报，保留最近 30 期。`, homePath: "/daily", pollHintMinutes: 30, ...CACHE },
  { id: "weekly", path: "/feed/weekly.xml", title: `${SITE.name} 周报`, description: `${SITE.name} ${EDITION_WHEN.weekly} 北京时间发布的周报：从上周每天的日报里选出的${REPORTS.entry.noun}，按栏目分好，附总述；保留最近 12 期。`, homePath: "/weekly", pollHintMinutes: 180, ...CACHE },
  { id: "monthly", path: "/feed/monthly.xml", title: `${SITE.name} 月报`, description: `${SITE.name} ${EDITION_WHEN.monthly} 北京时间发布的月报：从上个月每天的日报里选出的${REPORTS.entry.noun}，按栏目分好，附总述；保留最近 12 期。`, homePath: "/monthly", pollHintMinutes: 360, ...CACHE },
];

/** A feed by its id; a category feed shares the poll hint and caching of the feed it narrows. */
export function feedMeta(id: ItemFeedKind | ReportKind): FeedMeta {
  return FEEDS.find((f) => f.id === id)!;
}

export function feedCacheControl(id: ItemFeedKind | ReportKind): string {
  const m = feedMeta(id);
  return `public, max-age=${m.edgeCacheSeconds}, s-maxage=${m.edgeCacheSeconds}, stale-while-revalidate=${m.staleWhileRevalidateSeconds}`;
}

/** RSS <author> needs an address: a no-reply one on the site's own domain. */
const AUTHOR = `noreply@${new URL(config.siteUrl).hostname}`;

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")}]]>`;
}

function rfc822(d: Date): string {
  return d.toUTCString();
}

/** A module's reminder ahead of a feed's items (RequestNotices.feed). */
function noticeXml(n: FeedNotice): string {
  return `    <item>
      <title>${cdata(n.title)}</title>
      <link>${escapeXml(n.link)}</link>
      <description>${cdata(n.description)}</description>
      <pubDate>${rfc822(n.at)}</pubDate>
      <guid isPermaLink="false">${escapeXml(n.guid)}</guid>
      <author>${escapeXml(AUTHOR)} (${escapeXml(SITE.name)})</author>
    </item>`;
}

function channel(meta: { title: string; description: string; homePath: string; selfPath: string; ttl: number }, items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(meta.title)}</title>
    <link>${escapeXml(siteUrl(meta.homePath))}</link>
    <description>${escapeXml(meta.description)}</description>
    <language>zh-CN</language>
    <atom:link href="${escapeXml(siteUrl(meta.selfPath))}" rel="self" type="application/rss+xml" />
    <ttl>${meta.ttl}</ttl>
    <generator>${escapeXml(`${SITE.name} (${siteUrl("/agent")})`)}</generator>
${items.join("\n")}
  </channel>
</rss>
`;
}

type FeedRow = Pick<ItemRow, "id" | "title" | "summary" | "url" | "category" | "published_at" | "source_name"> &
  Partial<Pick<ItemRow, "channel" | "x_post" | "zh_text" | "quoted_zh" | "language"> & {
    syndicate: boolean; body_text: string | null; body_html: string | null; tr_html: string | null; tr_complete: boolean | null;
  }>;

/** Readers keep feed items for days: body images in full RSS are signed for a week, not a day. */
const FEED_IMAGE_SECONDS = 7 * 86400;

/**
 * The body a full feed carries, in Chinese when the page has it: an X post's translation (with the post
 * it quotes, translated too), else a complete Chinese translation of the article, else the original. It
 * ends with an attribution line (also a mark on copies taken from the feed).
 */
function fullContent(r: FeedRow, aihot: string): string | null {
  let html: string | null = null;
  const x = r.channel === "x" ? xView({ x_post: r.x_post ?? null, zh_text: r.zh_text ?? null, quoted_zh: r.quoted_zh ?? null }) : null;
  if (x?.text) {
    html = textToHtml(x.translation ?? x.text);
    if (x.quoted?.text) {
      html += `<blockquote><p>引用 @${escapeXml(x.quoted.handle)}：</p>${textToHtml(x.quoted.translation ?? x.quoted.text)}${x.quoted.url ? `<p><a href="${escapeXml(x.quoted.url)}">${escapeXml(x.quoted.url)}</a></p>` : ""}</blockquote>`;
    }
  } else if (r.body_html) {
    html = exportTranslation(r) ?? r.body_html;
  }
  if (!html) return null;
  return `${proxyBodyImages(html, true, FEED_IMAGE_SECONDS)}<p>—— 本文由 ${escapeXml(SITE.name)} 聚合整理，完整版与${escapeXml(subjectAfter("更多", "动态"))}见 <a href="${aihot}">${aihot}</a></p>`;
}

function itemXml(r: FeedRow, includeContent: boolean): string {
  const aihot = itemUrl(r.id);
  const summary = r.summary ?? "";
  const description = `<p>${escapeXml(summary)}</p>\n<p>🔗 <a href="${escapeXml(r.url)}">阅读原文</a></p>\n<p>via ${escapeXml(SITE.name)} · <a href="${aihot}">${aihot}</a></p>`;
  const publicCategory = toPublicApiCategory(r.category);
  const category = publicCategory ? `\n      <category>${escapeXml(feedCategoryLabel(publicCategory))}</category>` : "";
  let content = "";
  if (includeContent && r.syndicate) {
    const html = fullContent(r, aihot);
    if (html) content = `\n      <content:encoded>${cdata(html)}</content:encoded>`;
  }
  const pubDate = r.published_at ? `\n      <pubDate>${rfc822(r.published_at)}</pubDate>` : "";
  return `    <item>
      <title>${cdata(r.title)}</title>
      <link>${aihot}</link>
      <description>${cdata(description)}</description>${content}${category}${pubDate}
      <guid isPermaLink="false">${escapeXml(r.id)}</guid>
      <author>${escapeXml(AUTHOR)} (${escapeXml(publicSourceName(r.source_name))})</author>
    </item>`;
}

export type ItemFeedKind = "selected" | "selected-full" | "all";

// Items are the newest by their original publish time (the pubDate shown): 50 per feed; a category
// feed holds only its last 7 days (by original publish time).

/** A reminder for the feed at a path, or none (routes/feeds.ts asks the modules). */
type NoticeFor = (feedPath: string) => FeedNotice | null;

export async function itemFeed(kind: ItemFeedKind, category: PublicApiCategoryKey | null, { now = new Date(), notice }: { now?: Date; notice?: NoticeFor } = {}): Promise<string> {
  const includeContent = kind === "selected-full";
  const scope = kind === "all"
    ? sql`${listedCondition(now)} AND coalesce(p.published_at, p.discovered_at) > ${now}::timestamptz - interval '7 days'
        AND coalesce(p.published_at, p.discovered_at) <= ${now}`
    : sql`${seatedCondition(now)} ${publicCategoryCondition(category)}
        ${category ? sql`AND coalesce(p.published_at, p.discovered_at) >= ${new Date(now.getTime() - 7 * 86400_000)}` : sql``}`;
  const rows = await sql<FeedRow[]>`
    WITH page AS MATERIALIZED (
      SELECT p.article_id FROM publications p WHERE ${scope}
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC LIMIT 50
    )
    SELECT p.article_id AS id, p.title, p.summary, p.url, p.category, p.published_at, s.name AS source_name
      ${includeContent ? sql`, p.channel, p.syndicate, a.language, a.x_post,
        CASE WHEN p.channel = 'x' THEN tr.body_text END AS zh_text, qt.text_zh AS quoted_zh,
        left(a.body_text, 400) AS body_text, a.body_html, tr.body_html AS tr_html, tr.complete AS tr_complete` : sql``}
    FROM page JOIN publications p ON p.article_id = page.article_id JOIN sources s ON s.id = p.source_id
    ${includeContent ? sql`LEFT JOIN articles a ON a.id = p.article_id AND p.syndicate
      LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision
      LEFT JOIN quote_translations qt ON p.channel = 'x' AND qt.tweet_id = substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)')` : sql``}
    ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC`;
  const m = feedMeta(kind);
  let meta = { title: m.title, description: m.description, homePath: m.homePath, selfPath: m.path, ttl: m.pollHintMinutes };
  if (category) {
    const label = feedCategoryLabel(category);
    meta = {
      title: includeContent ? `${SITE.name} — ${label}全文` : `${SITE.name} — ${label}`,
      description: includeContent
        ? `${SITE.name} 每日精选「${label}」分类全文源。仅对明确允许再分发的来源内联正文。`
        : `${SITE.name} 每日精选「${label}」${subjectAfter("分类", "动态")}摘要，按分类订阅、不被全量精选刷屏。`,
      homePath: "/",
      selfPath: includeContent ? `/feed/full/category/${category}.xml` : `/feed/category/${category}.xml`,
      ttl: m.pollHintMinutes,
    };
  }
  const items = rows.map((r) => itemXml(r, includeContent));
  const first = notice?.(meta.selfPath);
  if (first) items.unshift(noticeXml(first));
  return channel(meta, items);
}

const ISSUE_NAME: Record<ReportKind, string> = { daily: "日报", weekly: "周报", monthly: "月报" };
/** Issues each report feed keeps: a month of dailies, a quarter of weeklies, a year of monthlies. */
const ISSUES_KEPT: Record<ReportKind, number> = { daily: 30, weekly: 12, monthly: 12 };

/** One issue: its headline, its lead (a weekly's or monthly's overview) and its contents, each entry linking to its page. */
function issueXml(kind: ReportKind, r: FeedIssue): string {
  const url = kind === "daily" ? dailyUrl(r.key) : periodUrl(kind, r.key);
  const name = `${SITE.name} ${ISSUE_NAME[kind]}`;
  const title = r.headline ? `${name} · ${r.key} — ${r.headline}` : `${name} · ${r.key}`;
  const contents = r.sections.map((s) => `<p><strong>${escapeXml(s.label)}</strong></p>\n<ul>${s.items.map((i) => `<li><a href="${escapeXml(i.link)}">${escapeXml(i.title)}</a></li>`).join("")}</ul>`);
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
export async function reportFeed(kind: ReportKind, notice?: NoticeFor): Promise<string> {
  const m = feedMeta(kind);
  const meta = { title: m.title, description: m.description, homePath: m.homePath, selfPath: m.path, ttl: m.pollHintMinutes };
  const items = (await feedIssues(kind, ISSUES_KEPT[kind])).map((r) => issueXml(kind, r));
  const first = notice?.(meta.selfPath);
  if (first) items.unshift(noticeXml(first));
  return channel(meta, items);
}

export function isFeedCategory(v: string): v is PublicApiCategoryKey {
  return (PUBLIC_API_CATEGORY_KEYS as readonly string[]).includes(v);
}
