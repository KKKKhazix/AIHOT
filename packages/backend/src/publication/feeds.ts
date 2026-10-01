import { listedCondition, selectedCondition } from "./scope.ts";
// RSS feeds. GUID = article id (isPermaLink=false), <link> = the site's page, pubDate = source
// publication time. Summary feeds never carry content:encoded; full feeds inline bodies only for
// sources that explicitly allow redistribution. Titles come from the site's name and categories.
import { CATEGORY_LABELS, PUBLIC_API_CATEGORY_KEYS, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { SITE, withSubject } from "@aihot/industry/site";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { escapeXml } from "../lib/text.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { reportHeadline, reportIndex } from "./reports.ts";
import { textToHtml } from "../content/sanitize.ts";
import { categoryCondition, xView, type ItemRow } from "./items.ts";
import { dailyUrl, itemUrl, siteUrl } from "./links.ts";

interface FeedMeta {
  id: string;
  path: string;
  title: string;
  description: string;
  homePath: string;
  pollHintMinutes: number;
}

const FEEDS: Record<"selected" | "selectedFull" | "all" | "daily", FeedMeta> = {
  selected: { id: "selected", path: "/feed.xml", title: `${SITE.name} — 精选`, description: `最新 50 条 ${SITE.name} 精选摘要，保留标题、站内阅读与原文入口；需要阅读器内全文可改订 /feed/full.xml。`, homePath: "/", pollHintMinutes: 30 },
  selectedFull: { id: "selected-full", path: "/feed/full.xml", title: `${SITE.name} — 精选全文`, description: "与精选摘要相同的最新 50 条；仅对明确允许再分发的来源内联正文，其余仍提供摘要和阅读入口。", homePath: "/", pollHintMinutes: 30 },
  all: { id: "all", path: "/feed/all.xml", title: `${SITE.name} — 全部动态`, description: "最近 7 天公开动态，按真实发布时间倒序；不含未审内容、低相关条目和已合并的重复条目。", homePath: "/all", pollHintMinutes: 30 },
  daily: { id: "daily", path: "/feed/daily.xml", title: `${SITE.name} ${withSubject("日报")}`, description: `${SITE.name} 每天 08:00 北京时间发布的${withSubject("日报")}，保留最近 30 期。`, homePath: "/daily", pollHintMinutes: 30 },
};

/** RSS <author> needs an address; a no-reply one on the site's own domain. */
const AUTHOR = `noreply@${new URL(config.siteUrl).hostname}`;

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")}]]>`;
}

function rfc822(d: Date): string {
  return d.toUTCString();
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

type FeedRow = Pick<ItemRow, "id" | "title" | "summary" | "url" | "category" | "published_at" | "discovered_at" | "source_name"> &
  Partial<Pick<ItemRow, "channel" | "x_post" | "zh_text" | "quoted_zh" | "language" | "syndicate"> & {
    body_html: string | null; tr_html: string | null; tr_complete: boolean | null;
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
    html = r.language !== "zh" && r.tr_html && r.tr_complete ? r.tr_html : r.body_html;
  }
  if (!html) return null;
  return `${proxyBodyImages(html, true, FEED_IMAGE_SECONDS)}<p>—— 本文由 ${escapeXml(SITE.name)} 聚合整理，完整版与更多动态见 <a href="${aihot}">${aihot}</a></p>`;
}

function itemXml(r: FeedRow, includeContent: boolean): string {
  const aihot = itemUrl(r.id);
  const summary = r.summary ?? "";
  const description = `<p>${escapeXml(summary)}</p>\n<p>🔗 <a href="${escapeXml(r.url)}">阅读原文</a></p>\n<p>via ${escapeXml(SITE.name)} · <a href="${aihot}">${aihot}</a></p>`;
  const label = r.category ? CATEGORY_LABELS[r.category as PublicApiCategoryKey] : undefined;
  const category = label ? `\n      <category>${escapeXml(label)}</category>` : "";
  let content = "";
  if (includeContent && r.syndicate) {
    const html = fullContent(r, aihot);
    if (html) content = `\n      <content:encoded>${cdata(html)}</content:encoded>`;
  }
  const pub = r.published_at ?? r.discovered_at;
  return `    <item>
      <title>${cdata(r.title)}</title>
      <link>${aihot}</link>
      <description>${cdata(description)}</description>${content}${category}
      <pubDate>${rfc822(pub)}</pubDate>
      <guid isPermaLink="false">${escapeXml(r.id)}</guid>
      <author>${AUTHOR} (${escapeXml(r.source_name)})</author>
    </item>`;
}

export type ItemFeedKind = "selected" | "selected-full" | "all";

// Like the live feeds, items are the newest by their original publish time (the pubDate shown):
// 50 per feed; a category feed holds only its last 7 days (by original publish time).

export async function itemFeed(kind: ItemFeedKind, category: PublicApiCategoryKey | null, now = new Date()): Promise<string> {
  const includeContent = kind === "selected-full";
  const scope = kind === "all"
    ? sql`${listedCondition(now)} AND coalesce(p.published_at, p.discovered_at) > ${now}::timestamptz - interval '7 days'
        AND coalesce(p.published_at, p.discovered_at) <= ${now}`
    : sql`${selectedCondition(now)} ${categoryCondition(category, true)}
        ${category ? sql`AND coalesce(p.published_at, p.discovered_at) >= ${new Date(now.getTime() - 7 * 86400_000)}` : sql``}`;
  const rows = await sql<FeedRow[]>`
    WITH page AS MATERIALIZED (
      SELECT p.article_id FROM publications p WHERE ${scope}
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC LIMIT 50
    )
    SELECT p.article_id AS id, p.title, p.summary, p.url, p.category, p.published_at, p.discovered_at, s.name AS source_name
      ${includeContent ? sql`, p.channel, p.syndicate, a.language, a.x_post,
        CASE WHEN p.channel = 'x' THEN tr.body_text END AS zh_text, qt.text_zh AS quoted_zh,
        a.body_html, tr.body_html AS tr_html, tr.complete AS tr_complete` : sql``}
    FROM page JOIN publications p ON p.article_id = page.article_id JOIN sources s ON s.id = p.source_id
    ${includeContent ? sql`LEFT JOIN articles a ON a.id = p.article_id AND p.syndicate
      LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision
      LEFT JOIN quote_translations qt ON p.channel = 'x' AND qt.tweet_id = substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)')` : sql``}
    ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC`;
  let meta: { title: string; description: string; homePath: string; selfPath: string; ttl: number };
  if (category) {
    const label = CATEGORY_LABELS[category] ?? category;
    meta = {
      title: includeContent ? `${SITE.name} — ${label}全文` : `${SITE.name} — ${label}`,
      description: includeContent
        ? `${SITE.name} 每日精选「${label}」分类全文源。仅对明确允许再分发的来源内联正文。`
        : `${SITE.name} 每日精选「${label}」分类摘要，按分类订阅、不被全量精选刷屏。`,
      homePath: "/",
      selfPath: includeContent ? `/feed/full/category/${category}.xml` : `/feed/category/${category}.xml`,
      ttl: 30,
    };
  } else {
    const m = FEEDS[kind === "selected" ? "selected" : kind === "selected-full" ? "selectedFull" : "all"];
    meta = { title: m.title, description: m.description, homePath: m.homePath, selfPath: m.path, ttl: m.pollHintMinutes };
  }
  return channel(meta, rows.map((r) => itemXml(r, includeContent)));
}

export async function dailyFeed(): Promise<string> {
  const index = await reportIndex("daily");
  const rows = index.rows.slice(0, 30);
  const m = FEEDS.daily;
  const gone = index.gone;
  const items = rows.map((r) => {
    const url = dailyUrl(r.key);
    const lead = reportHeadline(r.content, "daily", gone);
    const title = lead ? `${SITE.name} ${withSubject("日报")} · ${r.key} — ${lead}` : `${SITE.name} ${withSubject("日报")} · ${r.key}`;
    const description = `<p>${escapeXml(r.content.lead?.leadParagraph ?? lead ?? "")} — 点击查看完整日报</p>\n<p>via ${escapeXml(SITE.name)} · <a href="${url}">${url}</a></p>`;
    return `    <item>
      <title>${cdata(title)}</title>
      <link>${url}</link>
      <description>${cdata(description)}</description>
      <pubDate>${rfc822(r.generated_at)}</pubDate>
      <guid isPermaLink="false">daily-${escapeXml(r.key)}</guid>
      <author>${AUTHOR} (${escapeXml(SITE.name)})</author>
    </item>`;
  });
  return channel({ title: m.title, description: m.description, homePath: m.homePath, selfPath: m.path, ttl: m.pollHintMinutes }, items);
}

export function isFeedCategory(v: string): v is PublicApiCategoryKey {
  return (PUBLIC_API_CATEGORY_KEYS as readonly string[]).includes(v);
}
