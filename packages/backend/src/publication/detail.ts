// Item detail and Markdown export, both behind the same visibility and licence rules.
import type { OutlineEntry, SiteItemDetail, StoryRef } from "@aihot/contracts/site";
import { ITEM_COPY, SITE } from "@aihot/site";
import { bodyToMarkdown } from "../content/markdown.ts";
import { withCover, type Cover } from "../content/cover.ts";
import { sql } from "../db.ts";
import { isChineseText, stripTagMarkup } from "../lib/text.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { textToHtml } from "../content/sanitize.ts";
import { xArticleBody } from "../content/posts.ts";
import { eventPageCondition, exportTranslation, isChineseBody, ITEM_COLUMNS, ITEM_FROM, seatHolders, showsPost, thinPageCondition, toItemSummary, xView, type ItemRow } from "./items.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";
import { itemUrl, siteUrl } from "./links.ts";
import { hasItemPage, publicSourceName } from "./rules.ts";
import { tagTopics, topicLinks, topicMembership } from "./topics.ts";
import { firstDaily } from "./reports.ts";
import { mentionsIn } from "./mentions.ts";

interface DetailRow extends ItemRow {
  /** A post's long X Article as its page shows it (xArticleHtml); lists leave it out. */
  x_article_html: string | null;
  body_html: string | null;
  body_text: string | null;
  body_status: string;
  cover: Cover | null;
  tr_html: string | null;
  tr_complete: boolean | null;
  topics: string[];
  thin: boolean;
  /** Its event page stands for it in search (eventPageCondition). */
  event_page: boolean;
}

export type DetailResult =
  | { kind: "found"; item: SiteItemDetail; row: DetailRow }
  | { kind: "not_found" };

/** Adds stable ids to h2–h4 and returns the outline. */
function withOutline(html: string): { html: string; outline: OutlineEntry[] } {
  const outline: OutlineEntry[] = [];
  let n = 0;
  const out = html.replace(/<h([2-4])(?: id="sec-\d+")?>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    n += 1;
    const id = `sec-${n}`;
    const text = stripTagMarkup(inner, "").trim();
    if (text) outline.push({ id, text: text.slice(0, 80), level: Number(level) });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, outline };
}

async function loadRow(id: string, now = new Date()): Promise<DetailRow | null> {
  const [row] = await sql<DetailRow[]>`
    SELECT ${ITEM_COLUMNS}, CASE WHEN p.body_mode = 'full' THEN a.x_article->>'html' END AS x_article_html,
      a.body_html, a.body_text, a.body_status, a.cover, tr.body_html AS tr_html, tr.complete AS tr_complete,
      ${topicMembership()} AS topics, ${thinPageCondition()} AS thin, ${eventPageCondition(now)} AS event_page
    ${ITEM_FROM}
    WHERE p.article_id = ${id}`;
  return row ?? null;
}

/**
 * The body a page reads in `language` when it has it, else in the other: Chinese is the article's own text
 * or a translation (shown even before it is complete), the original only the article's own. `page` turns
 * the HTML shown into what is sent, with its outline.
 */
function readingBody(
  language: "zh" | "original",
  zh: { html: string; kind: "translation" | "original" } | null,
  original: string | null,
  complete: boolean,
  page: (html: string) => { html: string; outline: OutlineEntry[] },
): Pick<SiteItemDetail, "body" | "outline" | "hasTranslation" | "bodyLanguage"> {
  const bodyLanguage = language === "original" && original ? "original" : zh?.html ? "zh" : "original";
  const shown = bodyLanguage === "zh" ? zh!.html : original;
  const sent = shown ? page(shown) : { html: shown, outline: [] };
  return {
    body: { zh: bodyLanguage === "zh" ? sent.html : null, original: bodyLanguage === "original" ? sent.html : null, zhKind: zh?.kind ?? null, complete },
    outline: sent.outline,
    hasTranslation: zh?.kind === "translation" && !!zh.html && !!original,
    bodyLanguage,
  };
}

/**
 * Public detail (rules.hasItemPage) in one language, Chinese unless the original is asked for: items the
 * lists leave out (low relevance, merged duplicates, no Chinese summary yet) keep a noindex page;
 * withdrawn and hot_signal items are a 404.
 */
export async function loadItemDetail(id: string, language: "zh" | "original" = "zh", now = new Date()): Promise<DetailResult> {
  const row = await loadRow(id, now);
  if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return { kind: "not_found" };

  const summary = toItemSummary(row);
  if (row.visibility === "summary-only") {
    const item: SiteItemDetail = {
      ...summary,
      selected: false,
      score: null,
      category: null,
      story: null,
      reason: null,
      tags: [],
      x: null,
      readingMode: "summary-only",
      author: null,
      body: null,
      outline: [],
      relatedStories: [],
      topics: [],
      tagTopics: {},
      daily: null,
      indexable: false,
      googleNoindex: false,
      markdownAvailable: false,
      group: null,
      hasTranslation: false,
      bodyLanguage: "original",
      mentions: await mentionsIn([summary.summary]),
    };
    return { kind: "found", item, row };
  }

  const related = await sql<StoryRef[]>`
    SELECT DISTINCT st.public_id::text AS "publicId", st.title
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${id} AND fa.role <> 'mention' AND st.merged_into IS NULL
    ORDER BY "publicId" LIMIT 6`;

  let x: SiteItemDetail["x"] = null;
  let reading: Pick<SiteItemDetail, "body" | "outline" | "hasTranslation" | "bodyLanguage"> = { body: null, outline: [], hasTranslation: false, bodyLanguage: "original" };
  if (showsPost(row)) {
    const post = xView(row, false, true);
    if (row.x_article_html) {
      // A long X Article reads as an article: what the post says besides its link, then the article as
      // its author laid it out, with pictures and an outline; selected, it is in Chinese as an article is.
      const html = xArticleBody(String(row.x_post?.text ?? ""), row.x_article_html);
      const chinese = isChineseText(row.x_article?.text ?? "", row.language);
      const zh = chinese ? { html, kind: "original" as const } : row.tr_html ? { html: row.tr_html, kind: "translation" as const } : null;
      reading = readingBody(language, zh, chinese ? null : html, chinese ? true : row.tr_complete ?? false, (shown) => withOutline(proxyBodyImages(shown)));
    } else {
      const text = post?.text ?? String(row.x_post?.text ?? row.body_text ?? "");
      // A post's text is sent as written: its headings make the outline, without anchors. One written in
      // Chinese is the Chinese text, as an article's own Chinese body is.
      const own = text.trim() ? textToHtml(text) : null;
      // Judged on what the author wrote, not on the 【X 长文】 mark joined to it.
      const written = row.x_article?.text ?? String(row.x_post?.text ?? row.body_text ?? "");
      const chinese = !post?.translation && !!own && isChineseText(written, row.language);
      if (post?.translation || own) reading = readingBody(language, post?.translation ? { html: textToHtml(post.translation), kind: "translation" } : chinese ? { html: own!, kind: "original" } : null, chinese ? null : own, true,
        (html) => ({ html, outline: withOutline(html).outline }));
    }
    if (post) {
      const { text: _text, translation: _translation, quoted, ...shown } = post;
      x = {
        ...shown,
        quoted: quoted && {
          authorName: quoted.authorName, handle: quoted.handle, url: quoted.url,
          html: textToHtml(quoted.text), translationHtml: quoted.translation ? textToHtml(quoted.translation) : null,
        },
      };
    }
  } else if (row.body_mode === "full" && row.body_html) {
    const chinese = isChineseBody(row);
    const zh = chinese ? { html: row.body_html, kind: "original" as const } : row.tr_html ? { html: row.tr_html, kind: "translation" as const } : null;
    reading = readingBody(language, zh, chinese ? null : row.body_html, chinese ? true : row.tr_complete ?? false,
      (html) => withOutline(proxyBodyImages(withCover(html, row.cover, row.body_html))));
  }

  let group: SiteItemDetail["group"] = null;
  if (row.fact_id) {
    const [g] = await sql<{ public_id: string; reports: number; sources: number }[]>`
      SELECT f.public_id, count(p.article_id) AS reports, count(DISTINCT p.source_id) AS sources
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.id = ${row.fact_id} AND ${evidenceCondition()} AND ${listedCondition(now)}
      GROUP BY f.public_id`;
    if (g) {
      group = {
        factId: g.public_id,
        reportCount: Number(g.reports),
        additionalSourceCount: Math.max(0, Number(g.sources) - 1),
      };
    }
  }

  // The reason goes with the seat; a report yielding it points to the one holding it.
  const sameEvent = (await seatHolders([row], now)).get(row.id) ?? null;
  const item: SiteItemDetail = {
    ...summary,
    x,
    ...(sameEvent ? { reason: null, sameEvent } : {}),
    readingMode: "full",
    author: row.author,
    body: reading.body,
    outline: reading.outline,
    relatedStories: related,
    topics: topicLinks(row.topics),
    tagTopics: tagTopics(summary.tags),
    daily: await firstDaily(id),
    indexable: row.indexable,
    googleNoindex: row.indexable && (row.thin || row.event_page),
    markdownAvailable: markdownAvailable(row),
    group,
    hasTranslation: reading.hasTranslation,
    bodyLanguage: reading.bodyLanguage,
    mentions: await mentionsIn([summary.summary]),
  };
  return { kind: "found", item, row };
}

/**
 * Same predicate for the export button and the export route: a public page with something to export
 * (a summary, the post where pages show it, or a full-text body).
 */
export function markdownAvailable(row: {
  visibility: string; source_mode: string; summary: string | null; body_mode: string; body_html?: string | null; channel: string; x_post: Record<string, any> | null;
}): boolean {
  if (row.visibility !== "public" || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return false;
  return !!row.summary || (showsPost(row) && (!!row.x_post?.text || !!row.x_post?.media?.length || !!row.x_post?.quoted?.text)) || (row.body_mode === "full" && !!row.body_html);
}

export async function exportMarkdown(id: string): Promise<{ filename: string; body: string } | null> {
  const row = await loadRow(id);
  if (!row || !markdownAvailable(row)) return null;
  const lines: string[] = [];
  lines.push(`# ${row.title}`, "");
  if (row.original_title) lines.push(`> 原标题：${row.original_title}`, "");
  lines.push(`- 来源：${publicSourceName(row.source_name)}`);
  // Without a reliable date from the original, the time it was collected says so.
  lines.push(row.published_at ? `- 发布时间：${row.published_at.toISOString()}` : `- 收录时间：${row.discovered_at.toISOString()}`);
  lines.push(`- ${SITE.name}：${itemUrl(row.id)}`);
  lines.push(`- 原文：${row.url}`, "");
  if (row.summary) lines.push("## 摘要", "", row.summary, "");
  if (row.selected && row.seat && row.reason) lines.push(`## ${ITEM_COPY.reasonLabel}`, "", row.reason, "");
  if (showsPost(row) && row.x_post) {
    const post = xView(row);
    if (row.x_article_html) {
      // As an article's body is exported: a complete translation first, then the article as its page reads it.
      const written = { language: row.language, body_text: row.x_article?.text ?? "" };
      const translation = exportTranslation({ ...written, tr_html: row.tr_html, tr_complete: row.tr_complete });
      if (translation) lines.push("## 正文 · 中文译文", "", bodyToMarkdown(translation, row.url), "");
      lines.push(isChineseBody(written) ? "## 正文" : "## 正文 · 原文", "", bodyToMarkdown(xArticleBody(String(row.x_post.text ?? ""), row.x_article_html), row.url), "");
    } else if (post?.text) lines.push("## 正文", "", post.text, "");
    if (post?.translation) lines.push("## 中文译文", "", post.translation, "");
    for (const media of post?.media ?? []) {
      const url = media.url.startsWith("/") ? siteUrl(media.url) : media.url;
      lines.push(media.kind === "image" ? `![${media.alt ?? ""}](${url})` : `[视频](${url})`, "");
    }
    const q = post?.quoted;
    if (q?.text) lines.push(`## 引用 @${q.handle ?? ""}`, "", ...String(q.text).split("\n").map((l) => `> ${l}`), "", ...(q.url ? [q.url, ""] : []));
    if (q?.text && q.translation) lines.push("### 引用中文译文", "", ...q.translation.split("\n").map((l) => `> ${l}`), "");
  } else if (row.body_mode === "full" && row.body_html) {
    const translation = exportTranslation(row);
    if (translation) lines.push("## 正文 · 中文译文", "", bodyToMarkdown(withCover(translation, row.cover, row.body_html), row.url), "");
    lines.push(isChineseBody(row) ? "## 正文" : "## 正文 · 原文", "", bodyToMarkdown(withCover(row.body_html, row.cover, row.body_html), row.url), "");
  }
  return { filename: `${SITE.mcpPrefix}-${row.id}.md`, body: lines.join("\n").replace(/\n{3,}/g, "\n\n") };
}
