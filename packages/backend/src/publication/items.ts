// Public read layer, item level. Every exit (site API, v1, RSS, MCP, sitemap) reads
// items through these columns and views; which rows are public is decided by scope.ts.
import { CATEGORY_KEYS, toPublicApiCategory, type CategoryKey, type ChannelKey, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import type { FeedItemSummary, ItemSummary, MediaView, XPostView } from "@aihot/contracts/site";
import { POLICY } from "@aihot/site";
import { sql, type Db } from "../db.ts";
import { isEmptyOrLinkOnly } from "../content/posts.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { displayTags, publicSourceName } from "./rules.ts";
import { seatedCondition } from "./scope.ts";

export interface ItemRow {
  id: string;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  channel: "news" | "x";
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  /** Holds its fact's selected seat (publish.ts settleSeats). */
  seat: boolean;
  visibility: string;
  body_mode: "full" | "summary";
  indexable: boolean;
  fact_id: number | null;
  source_name: string;
  /** Participation mode of the source now (editorial, hot_signal, isolated). */
  source_mode: string;
  x_post: Record<string, any> | null;
  author: string | null;
  language: string | null;
  story_public_id: string | null;
  story_title: string | null;
  zh_text: string | null;
  /** Chinese translation of the post an X post quotes. */
  quoted_zh: string | null;
}

/** Columns every item listing selects. Internal judgement details never leave this layer. */
export const ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, p.reason, p.category, p.tags, p.score,
  p.selected, p.seat, p.channel, p.url, p.published_at, p.discovered_at, p.timeline_at, p.visibility,
  p.body_mode, p.indexable, p.fact_id, s.name AS source_name, s.participation_mode AS source_mode,
  a.x_post, a.author, a.language,
  st.public_id::text AS story_public_id, st.title AS story_title,
  CASE WHEN p.channel = 'x' THEN tr.body_text END AS zh_text, qt.text_zh AS quoted_zh`;

/** Public API listings never render article bodies, X media or story metadata. */
export type ApiItemRow = Pick<ItemRow, "id" | "title" | "original_title" | "summary" | "source_name" | "url" | "published_at" | "discovered_at" | "category" | "score" | "selected" | "reason">;
/** `selected` is the machine meaning: the report holds its fact's selected seat (scope.ts seatedCondition). */
export const API_ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, s.name AS source_name, p.url,
  p.published_at, p.discovered_at, p.category, p.score, (p.selected AND p.seat) AS selected, p.reason`;
export const API_ITEM_FROM = sql`FROM publications p JOIN sources s ON s.id = p.source_id`;

/** A translation of an older revision is left out: the original changed after it (the worker translates it again). */
export const ITEM_FROM = sql`
  FROM publications p
  JOIN sources s ON s.id = p.source_id
  JOIN articles a ON a.id = p.article_id
  LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
  LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision
  LEFT JOIN quote_translations qt ON p.channel = 'x' AND qt.tweet_id = substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)')`;

export function channelCondition(channel: ChannelKey | null | undefined) {
  if (!channel || channel === "all") return sql``;
  if (channel === "firstParty") return sql`AND p.source_id IN (SELECT id FROM sources WHERE tier = 'T1')`;
  return sql`AND p.channel = ${channel}`;
}

/** The website's filter: one of its own categories. */
export function categoryCondition(category: CategoryKey | null | undefined) {
  if (!category) return sql``;
  return sql`AND p.category = ${category}`;
}

/** The public API's, RSS's and MCP's filter: every category the site publishes as this one (PUBLIC_CATEGORIES). */
export function publicCategoryCondition(category: PublicApiCategoryKey | null | undefined) {
  if (!category) return sql``;
  return sql`AND p.category IN ${sql(CATEGORY_KEYS.filter((k) => toPublicApiCategory(k) === category))}`;
}

export function tagCondition(tag: string | null | undefined) {
  if (!tag) return sql``;
  return sql`AND p.tags @> ${[tag]}::text[]`;
}

function mediaView(m: Record<string, any>, mode: "card" | "thumb" | "full" = "thumb", responsive = false): MediaView | null {
  const url = proxiedImage(m.url, mode);
  if (!url) return null;
  const srcSet = responsive ? proxiedImageSet(m.poster ?? m.url, mode === "full" ? "body" : "card") : null;
  return {
    kind: m.kind === "video" ? "video" : "image",
    url,
    ...(responsive && mode !== "full" ? { fullUrl: proxiedImage(m.url, "full")! } : {}),
    ...(srcSet ? { srcSet } : {}),
    width: typeof m.width === "number" ? m.width : null,
    height: typeof m.height === "number" ? m.height : null,
    alt: m.alt ?? null,
    poster: m.poster ? proxiedImage(m.poster, mode === "card" ? "card" : "thumb") : null,
  };
}

export function xView(row: Pick<ItemRow, "x_post" | "zh_text"> & Partial<Pick<ItemRow, "quoted_zh">>, compact = false, responsive = compact): XPostView | null {
  const x = row.x_post;
  if (!x) return null;
  const quoted = x.quoted && typeof x.quoted === "object"
    ? {
      authorName: String(x.quoted.authorName ?? ""), handle: String(x.quoted.handle ?? ""), text: String(x.quoted.text ?? ""), url: String(x.quoted.url ?? ""),
      translation: !isEmptyOrLinkOnly(String(x.quoted.text ?? "")) && row.quoted_zh && row.quoted_zh.trim() !== String(x.quoted.text ?? "").trim() ? row.quoted_zh : null,
    }
    : null;
  const media = ((x.media ?? []) as Array<Record<string, any>>)
    .map((raw) => ({ raw, view: mediaView(raw, compact || !responsive ? "thumb" : "full", responsive) }))
    .filter((entry): entry is { raw: Record<string, any>; view: MediaView } => entry.view !== null);
  const avatarSrcSet = responsive ? proxiedImageSet(x.avatarUrl, "avatar") : null;
  return {
    authorName: String(x.authorName ?? x.handle ?? ""),
    handle: String(x.handle ?? ""),
    avatarUrl: proxiedImage(x.avatarUrl, "avatar"),
    ...(avatarSrcSet ? { avatarSrcSet } : {}),
    text: String(x.text ?? ""),
    translation: !isEmptyOrLinkOnly(String(x.text ?? "")) && row.zh_text && row.zh_text.trim() !== String(x.text ?? "").trim() ? row.zh_text : null,
    quoted,
    // A multi-image list grid is 112 CSS px wide; one image can be 240 px. Keep 3x pixels for both.
    // Detail retains full media for the lightbox; srcSet bounds the displayed image.
    media: media.map(({ raw, view }) => compact && media.length > 1 ? mediaView(raw, "card", responsive)! : view),
  };
}

/**
 * Whether pages show an X post's own text and media. A site that counts them as full text shows them
 * only where the source allows full text, as it does an article's body.
 */
export function showsPost(row: { channel: string; body_mode: string }): boolean {
  return row.channel === "x" && (!POLICY.xPostIsFullText || row.body_mode === "full");
}

/** The shared public article; its X post is added as each answer shows it. */
export function toItemSummary(row: ItemRow): ItemSummary {
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.original_title,
    summary: row.summary,
    reason: row.selected ? row.reason : null,
    source: { name: publicSourceName(row.source_name) },
    links: { original: row.url },
    publishedAt: row.published_at?.toISOString() ?? null,
    discoveredAt: row.discovered_at.toISOString(),
    timelineAt: row.timeline_at.toISOString(),
    category: (row.category as CategoryKey | null) ?? null,
    tags: displayTags(row.tags),
    score: row.score === null ? null : Math.round(Number(row.score)),
    selected: row.selected,
    channel: row.channel,
    story: row.story_public_id ? { publicId: row.story_public_id, title: row.story_title ?? "" } : null,
  };
}

/** Project the shared public article into the exact fields a site card renders. */
export function toFeedItemSummary(row: ItemRow): FeedItemSummary {
  const item = toItemSummary(row);
  const x = showsPost(row) ? xView(row, true) : null;
  return {
    id: item.id, title: item.title, summary: item.summary ?? (x?.text || null), reason: item.reason,
    source: item.source, publishedAt: item.publishedAt, timelineAt: item.timelineAt,
    category: item.category, tags: item.tags, score: item.score, selected: item.selected, channel: item.channel,
    x: x ? {
      authorName: x.authorName, handle: x.handle, avatarUrl: x.avatarUrl,
      ...(x.avatarSrcSet ? { avatarSrcSet: x.avatarSrcSet } : {}), media: x.media,
      quoted: x.quoted ? { authorName: x.quoted.authorName, handle: x.quoted.handle, text: x.quoted.text, translation: x.quoted.translation } : null,
    } : null,
  };
}

/**
 * An article written in Chinese: its language says so, or its text opens in Chinese and it is not marked
 * English (the translator's rule, editorial/translate.ts). Every exit shows such a body as it is.
 */
export function isChineseBody(a: { language?: string | null; body_text?: string | null }): boolean {
  return a.language === "zh" || (/[一-鿿]/.test(a.body_text?.slice(0, 400) ?? "") && a.language !== "en");
}

/** The complete Chinese translation an export (Markdown, full RSS) carries; a page also shows a partial one. */
export function exportTranslation(a: { language?: string | null; body_text?: string | null; tr_html?: string | null; tr_complete?: boolean | null }): string | null {
  return !isChineseBody(a) && a.tr_html && a.tr_complete ? a.tr_html : null;
}

/**
 * For listed rows that are selected but yield their fact's seat: the report holding it, by row id.
 * (The home timeline folds these into reading groups; flat lists say which report stands for them.)
 */
export async function seatHolders(rows: ItemRow[], now: Date, db: Db = sql): Promise<Map<string, { id: string; title: string }>> {
  const yielding = rows.filter((r) => r.selected && !r.seat && r.fact_id !== null);
  if (!yielding.length) return new Map();
  const holders = await db<{ fact_id: number; id: string; title: string }[]>`
    SELECT p.fact_id, p.article_id AS id, p.title FROM publications p
    WHERE p.fact_id IN ${db([...new Set(yielding.map((r) => r.fact_id!))])} AND ${seatedCondition(now)}`;
  const byFact = new Map(holders.map((h) => [Number(h.fact_id), { id: h.id, title: h.title }]));
  return new Map(yielding.flatMap((r) => (byFact.has(Number(r.fact_id)) ? [[r.id, byFact.get(Number(r.fact_id))!] as const] : [])));
}
