// What the judging steps read about an article: loaded once per analysis and rendered per step.
import * as cheerio from "cheerio";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { collapseWhitespace, truncate } from "../lib/text.ts";
import { produceImage } from "../media/images.ts";
import type { ContentPart } from "../providers/llm.ts";
import { loadReading, validReading } from "../content/reading.ts";

export interface AnalyzeInputArticle {
  id: string;
  revision: number;
  title: string;
  url: string;
  author: string | null;
  publishedAt: Date | null;
  /** When the site first saw it (the score input's time when the source gives none). */
  discoveredAt?: Date | null;
  bodyText: string | null;
  readingId?: number | null;
  readingGeneration?: number;
  excerpt: string | null;
  /** pending: no body fetched yet; ok; unconfirmed: fetching failed; none. */
  bodyStatus?: string;
  xPost: Record<string, any> | null;
  media: Array<Record<string, any>>;
  source: {
    name: string;
    kind: string;
    tier: string;
    firstParty: boolean;
    tags?: string[];
    ownerEntityId?: string | null;
    /** The source asks for the article page (fetchPublicContent, detail pages, web listings). */
    fetchesBody?: boolean;
  };
  /** Stored Chinese translation of the body (e.g. a full post whose original was truncated). */
  translationZh?: string | null;
}

/**
 * The post as the judging steps read it: an X Article it published joins its text, so every step sees
 * the article rather than a bare link.
 */
export function withXArticle(xPost: Record<string, any> | null, article: { title?: string; text?: string } | null): Record<string, any> | null {
  if (!xPost || !article?.text) return xPost;
  const parts = [String(xPost.text ?? "").trim(), article.title ? `【X 长文】${article.title}` : "【X 长文】", article.text];
  return { ...xPost, text: parts.filter(Boolean).join("\n\n") };
}

export async function loadAnalyzeInput(articleId: string): Promise<AnalyzeInputArticle | null> {
  const [row] = await sql<{
    id: string; revision: number; title: string; url: string; author: string | null; published_at: Date | null; discovered_at: Date;
    body_html: string | null; body_text: string | null; excerpt: string | null; body_status: string; x_post: Record<string, any> | null; x_article: { title?: string; text?: string } | null;
    media: Array<Record<string, any>>; source_name: string; source_kind: string; tier: string; first_party: boolean; source_tags: string[]; owner_entity_id: string | null;
    config: Record<string, any>; translation_zh: string | null; reading_generation: number; accepted_reading_id: number | null;
  }[]>`
    SELECT a.id, a.revision, a.reading_generation, a.accepted_reading_id, a.title, a.url, a.author, a.published_at, a.discovered_at, a.body_html, a.body_text, a.excerpt, a.body_status, a.x_post, a.x_article, a.media,
           s.name AS source_name, s.kind AS source_kind, s.tier, s.first_party, s.tags AS source_tags, s.owner_entity_id, s.config,
           tr.body_text AS translation_zh
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'zh' AND tr.revision >= a.revision
    WHERE a.id = ${articleId}`;
  if (!row) return null;
  const r = row.accepted_reading_id ? await loadReading(row.accepted_reading_id) : null;
  const reading = validReading(row, r) ? r : null;
  return {
    id: row.id, revision: row.revision, title: row.title, url: row.url, author: row.author, publishedAt: row.published_at, discoveredAt: row.discovered_at,
    bodyText: reading?.body_text ?? row.body_text, readingId: reading?.id ?? null, readingGeneration: row.reading_generation, excerpt: row.excerpt, bodyStatus: reading ? "ok" : row.body_status,
    xPost: withXArticle(row.x_post, row.x_article), media: row.x_post || !row.body_html ? row.media : bodyImages(row.body_html),
    source: {
      name: row.source_name, kind: row.source_kind, tier: row.tier, firstParty: row.first_party, tags: row.source_tags, ownerEntityId: row.owner_entity_id,
      fetchesBody: row.config?.fetchPublicContent === true || !!row.config?.detail || row.source_kind === "web_list",
    },
    translationZh: row.translation_zh,
  };
}

const KIND_LABEL: Record<string, string> = {
  rss: "RSS", web_list: "网页", json_list: "网页接口", x_search: "X 帖子", mp_account: "微信公众号", external: "外部上报",
};

/** The material as the structure step reads it (source facts, text, link). */
export function buildMaterial(a: AnalyzeInputArticle): string {
  const lines: string[] = [];
  lines.push("<source>");
  lines.push(`名称：${a.source.name}`);
  lines.push(`类型：${KIND_LABEL[a.source.kind] ?? a.source.kind}；分级：${a.source.tier}；一手来源：${a.source.firstParty ? "是" : "否"}`);
  lines.push("</source>");
  lines.push("<material>");
  if (a.publishedAt) lines.push(`发布时间：${beijingDate(a.publishedAt)} ${beijingTime(a.publishedAt)}（北京时间）`);
  if (a.author) lines.push(`作者：${a.author}`);
  if (a.readingId) {
    lines.push(`标题：${a.title}`, `已确认正文（含图片转录，读取版本 ${a.readingId}）：\n${a.bodyText ?? ""}`);
  } else if (a.xPost) {
    lines.push(`作者：${a.xPost.authorName ?? ""} (@${a.xPost.handle ?? ""})`);
    lines.push(`帖子：\n${truncate(String(a.xPost.text ?? a.title), 4000)}`);
    if (a.xPost.quoted?.text) lines.push(`引用的帖子（@${a.xPost.quoted.handle ?? ""}）：\n${truncate(String(a.xPost.quoted.text), 2000)}`);
    if (a.translationZh) lines.push(`帖子中文译文：\n${truncate(a.translationZh, 4000)}`);
  } else {
    lines.push(`标题：${collapseWhitespace(a.title)}`);
    const body = a.bodyText ?? a.excerpt ?? "";
    lines.push(body ? `正文：\n${truncate(body, 7000)}` : "正文：（无）");
    if (a.translationZh && !a.bodyText) lines.push(`正文中文译文：\n${truncate(a.translationZh, 5000)}`);
  }
  lines.push(`原文链接：${a.url}`);
  lines.push("</material>");
  return lines.join("\n");
}

/** Images from the confirmed body take precedence over listing thumbnails and site logos. */
export function bodyImages(html: string): Array<{ kind: "image"; url: string }> {
  const $ = cheerio.load(html, null, false);
  return [...new Set($("img[src]").toArray().map((el) => $(el).attr("src")!).filter((url) => /^https?:\/\//.test(url)))].map((url) => ({ kind: "image", url }));
}

export function bodyImageUrls(a: AnalyzeInputArticle): string[] {
  return [...new Set([...(a.xPost?.media ?? []), ...(a.xPost?.quoted?.media ?? []), ...a.media]
    .filter((m) => m.kind === "image" && /^https?:\/\//.test(String(m.url))).map((m) => String(m.url)))];
}

/** Up to four body images, in reading order, at reading resolution rather than thumbnail size. */
export async function bodyImageParts(a: AnalyzeInputArticle): Promise<ContentPart[]> {
  if (a.readingId) return [];
  const urls = bodyImageUrls(a).slice(0, 4);
  const parts = await Promise.all(urls.map(async (url): Promise<ContentPart | null> => {
    try {
      const { body, type } = await produceImage(url, "full");
      return /^image\/(jpeg|png|webp)$/.test(type) ? { type: "image_url", image_url: { url: `data:${type};base64,${body.toString("base64")}` } } : null;
    } catch {
      return null;
    }
  }));
  return parts.filter((part): part is ContentPart => part !== null);
}
