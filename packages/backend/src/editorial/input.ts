// What the judging steps read about an article: loaded once per analysis and rendered per step.
import sharp from "sharp";
import { describePublicationTime } from "../sources/dates.ts";
import { sql } from "../db.ts";
import { collapseWhitespace, htmlBlockText, mergeDistinctText, truncate } from "../lib/text.ts";
import { produceImage, rasterImage, SVG_PASSTHROUGH_MAX_BYTES } from "../media/images.ts";
import { editorialPolicy, type EditorialLoadedImages } from "../modules.ts";
import type { ContentPart } from "../providers/llm.ts";
import { MAX_BODY_CHARS } from "./writing.ts";
import { withXArticle } from "../content/posts.ts";
import { collectImageUrls, htmlAltText, mediaAltText } from "../content/presentation.ts";

export interface AnalyzeInputArticle {
  id: string;
  revision: number;
  title: string;
  url: string;
  author: string | null;
  publishedAt: Date | null;
  publicationTime?: string | null;
  /** When the site first saw it; never evidence of when the source published it. */
  discoveredAt?: Date | null;
  bodyText: string | null;
  fullBodyText?: string | null;
  excerpt: string | null;
  /** pending: no body fetched yet; ok; unconfirmed: fetching failed; none. */
  bodyStatus?: string;
  xPost: Record<string, any> | null;
  rawXPostText?: string | null;
  rawXQuotedText?: string | null;
  xArticleText?: string | null;
  imageUrls?: string[];
  media: Array<Record<string, any>>;
  source: {
    name: string;
    kind: string;
    tier: string;
    /** Raises the tier's selection threshold (industry/selection.ts classes); null for none. */
    selectionClass?: string | null;
    firstParty: boolean;
    tags?: string[];
    ownerEntityId?: string | null;
    /** The source asks for the article page (fetchPublicContent, detail pages, web listings). */
    fetchesBody?: boolean;
  };
  /** Stored Chinese translation of the body (e.g. a full post whose original was truncated). */
  translationZh?: string | null;
}

export async function loadAnalyzeInput(articleId: string): Promise<AnalyzeInputArticle | null> {
  const review = Boolean(editorialPolicy().reviewAnalysis);
  const [row] = await sql<{
    id: string; revision: number; title: string; url: string; author: string | null; published_at: Date | null; publication_time: string | null; discovered_at: Date;
    body_text: string | null; body_html: string | null; excerpt: string | null; body_status: string; x_post: Record<string, any> | null; x_article: { title?: string; text?: string; html?: string } | null;
    cover: Record<string, any> | null; media: Array<Record<string, any>>; source_name: string; source_kind: string; tier: string; selection_class: string | null; source_tags: string[]; owner_entity_id: string | null;
    config: Record<string, any>; translation_zh: string | null;
  }[]>`
    SELECT a.id, a.revision, a.title, a.url, a.author, a.published_at, a.publication_time, a.discovered_at, a.body_text, a.excerpt, a.body_status, a.x_post, a.x_article, a.media,
           ${review ? sql`a.body_html, a.cover` : sql`NULL AS body_html, NULL AS cover`},
           s.name AS source_name, s.kind AS source_kind, s.tier, s.selection_class, s.tags AS source_tags, s.owner_entity_id, s.config,
           tr.body_text AS translation_zh
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'zh' AND tr.revision >= a.revision
    WHERE a.id = ${articleId}`;
  if (!row) return null;
  return {
    id: row.id, revision: row.revision, title: row.title, url: row.url, author: row.author, publishedAt: row.published_at, publicationTime: row.publication_time, discoveredAt: row.discovered_at,
    bodyText: row.body_text,
    excerpt: row.excerpt, bodyStatus: row.body_status, xPost: withXArticle(row.x_post, row.x_article),
    ...(review ? {
      fullBodyText: mergeDistinctText(row.body_text, htmlBlockText(row.body_html), htmlAltText(row.body_html), mediaAltText(row.media), typeof row.cover?.alt === "string" ? row.cover.alt : null) || null,
      rawXPostText: mergeDistinctText(row.x_post?.text ? String(row.x_post.text) : null, mediaAltText(row.x_post?.media)) || null,
      rawXQuotedText: mergeDistinctText(row.x_post?.quoted?.text ? String(row.x_post.quoted.text) : null, mediaAltText(row.x_post?.quoted?.media)) || null,
      xArticleText: mergeDistinctText(row.x_article?.title, row.x_article?.text, htmlBlockText(row.x_article?.html), htmlAltText(row.x_article?.html)) || null,
      imageUrls: collectImageUrls({ html: row.body_html, xArticleHtml: row.x_article?.html ?? null, cover: row.cover, media: row.media, xPost: row.x_post }),
    } : {}),
    media: row.media,
    source: {
      name: row.source_name, kind: row.source_kind, tier: row.tier, selectionClass: row.selection_class, firstParty: row.tier === "T1", tags: row.source_tags, ownerEntityId: row.owner_entity_id,
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
  // Conditions often occur at the end of an announcement. Use the existing body budget instead of
  // only its lead; beyond it, state the missing tail so it is not mistaken for complete evidence.
  const body = (text: string) => text.length <= MAX_BODY_CHARS ? text : `${text.slice(0, MAX_BODY_CHARS)}\n【原文超过 ${MAX_BODY_CHARS} 字符，后文未提供】`;
  const lines: string[] = [];
  lines.push("<source>");
  lines.push(`名称：${a.source.name}`);
  lines.push(`类型：${KIND_LABEL[a.source.kind] ?? a.source.kind}；分级：${a.source.tier}；一手来源：${a.source.firstParty ? "是" : "否"}`);
  lines.push("</source>");
  lines.push("<material>");
  if (a.publishedAt) lines.push(`发布时间：${describePublicationTime(a.publishedAt, a.publicationTime)}`);
  if (a.author) lines.push(`作者：${a.author}`);
  if (a.xPost) {
    lines.push(`作者：${a.xPost.authorName ?? ""} (@${a.xPost.handle ?? ""})`);
    lines.push(`帖子：\n${body(String(a.xPost.text ?? a.title))}`);
    if (a.xPost.quoted?.text) lines.push(`引用的帖子（@${a.xPost.quoted.handle ?? ""}）：\n${body(String(a.xPost.quoted.text))}`);
    if (a.translationZh) lines.push(`帖子中文译文：\n${truncate(a.translationZh, 4000)}`);
  } else {
    lines.push(`标题：${collapseWhitespace(a.title)}`);
    const original = a.bodyText ?? a.excerpt ?? "";
    lines.push(original ? `正文：\n${body(original)}` : "正文：（无）");
    if (a.translationZh && !a.bodyText) lines.push(`正文中文译文：\n${truncate(a.translationZh, 5000)}`);
  }
  lines.push(`原文链接：${a.url}`);
  lines.push("</material>");
  return lines.join("\n");
}

async function imagePart(body: Buffer, type: string): Promise<ContentPart | null> {
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
  const { width, height } = await sharp(body).metadata();
  // Vision providers reject either side at 10 pixels or below. Pad thin thumbnails without
  // dropping review evidence, stretching their content or changing the reader's cached image.
  if (width! <= 10 || height! <= 10) {
    body = await sharp(body).extend({ top: 0, left: 0, right: Math.max(0, 11 - width!), bottom: Math.max(0, 11 - height!), background: "#fff" }).toBuffer();
  }
  return { type: "image_url", image_url: { url: `data:${type};base64,${body.toString("base64")}` } };
}

/**
 * The article's first image, inlined: models often cannot reach the original hosts, so they get the
 * site's cached thumbnail. None when it cannot be fetched.
 * A post without its own image shows the quoted post's (a reaction to a chart or a launch card).
 */
export async function firstImagePart(a: Pick<AnalyzeInputArticle, "media"> & Partial<Pick<AnalyzeInputArticle, "xPost">>): Promise<ContentPart | null> {
  const image = [...(a.xPost?.media ?? []), ...(a.xPost?.quoted?.media ?? []), ...(a.media ?? [])].find((m: any) => m.kind === "image" && m.url);
  if (!image) return null;
  try {
    let { body, type } = await produceImage(String(image.url), "thumb");
    // The display can retain a large vector to save transfer; the model still needs the bitmap
    // thumbnail it received before that optimization. Compact SVGs keep their existing omission.
    if (type === "image/svg+xml" && body.length > SVG_PASSTHROUGH_MAX_BYTES) {
      ({ body, type } = await rasterImage(body, type, "thumb"));
    }
    return await imagePart(body, type);
  } catch {
    return null;
  }
}

const MAX_REVIEW_IMAGES = 16;

function decodeDataImage(url: string): { body: Buffer; type: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+)(?:;charset=[^;,]+)?;base64,([a-z0-9+/=\s]+)$/i.exec(url);
  if (!m) return null;
  return { type: m[1]!.toLowerCase(), body: Buffer.from(m[2]!.replace(/\s+/g, ""), "base64") };
}

/** Loads all displayable article images as bitmap thumbnails for vision compliance review. */
export async function loadArticleImageParts(urls: readonly string[]): Promise<EditorialLoadedImages> {
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) return { parts: [], unverifiedCount: 0 };
  const parts: ContentPart[] = [];
  let unverifiedCount = unique.length > MAX_REVIEW_IMAGES ? unique.length - MAX_REVIEW_IMAGES : 0;
  for (const url of unique.slice(0, MAX_REVIEW_IMAGES)) {
    try {
      let body: Buffer;
      let type: string;
      if (/^data:image\//i.test(url)) {
        const decoded = decodeDataImage(url);
        if (!decoded) {
          unverifiedCount += 1;
          continue;
        }
        ({ body, type } = await rasterImage(decoded.body, decoded.type, "thumb"));
      } else {
        ({ body, type } = await produceImage(url, "thumb"));
        if (type === "image/svg+xml") {
          ({ body, type } = await rasterImage(body, type, "thumb"));
        }
      }
      const part = await imagePart(body, type);
      if (part) {
        parts.push(part);
      } else {
        unverifiedCount += 1;
      }
    } catch (error) {
      if (/^upstream (?:404|410)$/.test((error as Error)?.message ?? "")) continue;
      unverifiedCount += 1;
    }
  }
  return { parts, unverifiedCount };
}
