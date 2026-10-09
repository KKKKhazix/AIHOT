// The single entrance for new material from every channel (collectors, external reports, imports).
// It owns identity, revisions and the timeline rule, so no entrance can bypass them.
import { sql, type Db, type Tx } from "../db.ts";
import { newArticleId, sha256 } from "../lib/ids.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { groupingReset, reconcileMaterialSource } from "./provenance.ts";
import { emit } from "../modules.ts";

export interface MediaItem {
  kind: "image" | "video";
  url: string;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
  poster?: string | null;
}

export interface XPostData {
  tweetId: string;
  authorName: string;
  handle: string;
  avatarUrl?: string | null;
  text: string;
  quoted?: { authorName: string; handle: string; text: string; url: string; media?: MediaItem[] } | null;
  media?: MediaItem[];
  lang?: string | null;
  replyTo?: string | null;
}

export interface MaterialInput {
  sourceId: string;
  url: string;
  title: string;
  identityKey?: string;
  author?: string | null;
  language?: string | null;
  publishedAt?: Date | null;
  sourceUpdatedAt?: Date | null;
  excerpt?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  bodyStatus?: "pending" | "ok" | "unconfirmed" | "none";
  media?: MediaItem[];
  xPost?: XPostData | null;
  raw?: unknown;
  /** How it arrived: the engine's collection, the ingest API or an import, or the module that brought it (its name). */
  via: "fetch" | "ingest" | "import" | (string & {});
  discoveredAt?: Date;
  /** Explicit backfill: first import of a new source, or a report flagged as backfill. */
  backfill?: string | null;
  /** Keep an existing id when importing history. */
  id?: string;
}

export interface MaterialResult {
  articleId: string;
  created: boolean;
  revised: boolean;
  backfill: boolean;
  /** Provenance moved an unanalysed signal into editorial processing, without a material revision. */
  processingNeeded?: boolean;
}

// Material first discovered more than this long after its source time is archived by source time,
// stays out of "today" and is never pushed. Must not be wider than the 72 h the v1 contract states.
export const STALE_ON_DISCOVERY_MS = 48 * 3600 * 1000;
// Source times more than an hour in the future are not trusted.
export const FUTURE_TOLERANCE_MS = 3600 * 1000;

export interface TimelineDecision {
  publishedAt: Date | null;
  timelineAt: Date;
  backfill: boolean;
  backfillReason: string | null;
}

/** The one timeline rule shared by every entrance. */
export function decideTimeline(claimed: Date | null | undefined, discoveredAt: Date, explicitBackfill?: string | null): TimelineDecision {
  let publishedAt: Date | null = claimed && Number.isFinite(claimed.getTime()) ? claimed : null;
  if (publishedAt && publishedAt.getTime() > discoveredAt.getTime() + FUTURE_TOLERANCE_MS) publishedAt = null;
  let backfillReason: string | null = null;
  if (explicitBackfill) backfillReason = explicitBackfill;
  else if (!publishedAt) backfillReason = "unknown-publication-time";
  else if (publishedAt && discoveredAt.getTime() - publishedAt.getTime() > STALE_ON_DISCOVERY_MS) backfillReason = "stale-on-discovery";
  const backfill = backfillReason !== null;
  const timelineAt = backfill && publishedAt ? publishedAt : discoveredAt;
  return { publishedAt, timelineAt, backfill, backfillReason };
}

/**
 * Fill a missing publication date from the original listing or page, against the first discovery
 * time. Explicit imports stay backfills. The caller holds the article lock and revises the material
 * with this change, so analysis and grouping cannot retain a decision made on an undated input.
 */
export async function fillPublicationTime(db: Db, articleId: string, claimed: Date | null | undefined): Promise<TimelineDecision | null> {
  if (!claimed || !Number.isFinite(claimed.getTime())) return null;
  const [a] = await db<{ published_at: Date | null; discovered_at: Date; backfill_reason: string | null }[]>`
    SELECT published_at, discovered_at, backfill_reason FROM articles WHERE id = ${articleId}`;
  if (!a || a.published_at) return null;
  const explicit = a.backfill_reason === "unknown-publication-time" ? null : a.backfill_reason;
  const next = decideTimeline(claimed, a.discovered_at, explicit);
  if (!next.publishedAt) return null;
  await db`UPDATE articles SET published_at = ${next.publishedAt}, published_at_claim = ${claimed},
    timeline_at = ${next.timelineAt}, backfill = ${next.backfill}, backfill_reason = ${next.backfillReason} WHERE id = ${articleId}`;
  return next;
}

/**
 * History rather than news: a backfill (a new source's first import, stale on discovery, flagged by
 * a report) whose source time is unknown or was already past the stale threshold when found. It is
 * archived and analysed like anything else, but waits behind live work and founds no event and adds
 * no heat (it stays out of the event graph). A new source's post from this morning is news.
 */
export function isHistorical(a: { backfill: boolean; published_at: Date | null; discovered_at: Date }): boolean {
  return a.backfill && (!a.published_at || a.discovered_at.getTime() - a.published_at.getTime() > STALE_ON_DISCOVERY_MS);
}

/** Identity of stored content: the revision changes exactly when this does. */
export function contentHash(c: { title: string; bodyText?: string | null; excerpt?: string | null }): string {
  return sha256([collapseWhitespace(c.title), collapseWhitespace(c.bodyText ?? ""), collapseWhitespace(c.excerpt ?? "")].join("\u0001"));
}

const LOST = "\uFFFD";

/**
 * Whether two renderings of a text differ only where a character was lost in transit: a U+FFFD (a run
 * of them, from an older decode) on either side stands for any one character. Some feeds garble a
 * few characters at random on every load, so no two loads of its articles are the same text.
 */
function sameBarringLoss(a: string | null | undefined, b: string | null | undefined): boolean {
  const chars = (s: string | null | undefined) => Array.from(collapseWhitespace(s ?? "").replace(/\uFFFD+/g, LOST));
  const x = chars(a);
  const y = chars(b);
  return x.length === y.length && x.every((c, i) => c === y[i] || c === LOST || y[i] === LOST);
}

export function identityKeyFor(m: MaterialInput): string {
  if (m.identityKey) return m.identityKey;
  if (m.xPost?.tweetId) return `x:${m.xPost.tweetId}`;
  const fromUrl = identityKeyForUrl(m.url);
  if (fromUrl) return fromUrl;
  return `src:${m.sourceId}:${sha256(m.url + "\u0001" + m.title).slice(0, 32)}`;
}

/**
 * A publisher's stable entry ID survives a URL rename. Reuse the earliest material for that ID within
 * its source; new entries still use URL identity, so another discovery of the same URL converges.
 * Existing duplicate rows remain untouched. Only collectors declaring an external ID call this.
 */
export async function reuseExternalMaterialIdentities<C extends Pick<MaterialInput, "identityKey" | "raw">>(sourceId: string, candidates: C[], db: Db = sql): Promise<C[]> {
  const externalId = (raw: unknown): string | null => {
    const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>).externalId : null;
    return typeof value === "string" && value.length > 0 ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  };
  const ids = [...new Set(candidates.map(c => externalId(c.raw)).filter((id): id is string => id !== null))];
  if (ids.length === 0) return candidates;
  const rows = await db<{ external_id: string; identity_key: string }[]>`
    SELECT DISTINCT ON (raw->>'externalId') raw->>'externalId' AS external_id, identity_key
    FROM articles WHERE source_id = ${sourceId} AND raw->>'externalId' = ANY(${ids}::text[])
    ORDER BY raw->>'externalId', discovered_at, id`;
  const known = new Map(rows.map(row => [row.external_id, row.identity_key]));
  return candidates.map(candidate => {
    const key = known.get(externalId(candidate.raw) ?? "");
    return key ? { ...candidate, identityKey: key } : candidate;
  });
}

/**
 * Stores material. Existing identities get a discovery record, and a new revision only when the
 * stored content really changes. Concurrent reports of the same material are serialised on the row,
 * so every change gets its own revision number. Returns whether processing is needed.
 */
export async function upsertMaterial(m: MaterialInput, db: Db = sql): Promise<MaterialResult> {
  const run = (tx: Db) => upsertIn(tx, m);
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}

async function lockMaterial(db: Db, identityKey: string) {
  const [existing] = await db<{ id: string; source_id: string; revision: number; content_hash: string | null; backfill: boolean; published_at: Date | null; title: string; body_text: string | null; excerpt: string | null; participation_mode: string }[]>`
    SELECT a.id, a.source_id, a.revision, a.content_hash, a.backfill, a.published_at, a.title, a.body_text, a.excerpt, s.participation_mode
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.identity_key = ${identityKey} FOR UPDATE OF a`;
  return existing;
}

async function upsertIn(db: Db, m: MaterialInput): Promise<MaterialResult> {
  m = { ...m,
    publishedAt: m.publishedAt && Number.isFinite(m.publishedAt.getTime()) ? m.publishedAt : null,
    sourceUpdatedAt: m.sourceUpdatedAt && Number.isFinite(m.sourceUpdatedAt.getTime()) ? m.sourceUpdatedAt : null,
  };
  const identityKey = identityKeyFor(m);
  const discoveredAt = m.discoveredAt ?? new Date();
  const title = collapseWhitespace(m.title).slice(0, 1000) || m.url;

  const t = decideTimeline(m.publishedAt, discoveredAt, m.backfill);
  // Most listing entries are already stored. Lock and reuse those rows without attempting an
  // insert of their body and raw payload on every collection. The unique key still arbitrates
  // concurrent first discoveries; after losing that insert, read and lock its winner.
  let existing = await lockMaterial(db, identityKey);
  if (!existing) {
    const newId = m.id ?? newArticleId();
    const hash = contentHash({ title, bodyText: m.bodyText, excerpt: m.excerpt });
    const [inserted] = await db<{ id: string }[]>`
      INSERT INTO articles (id, source_id, identity_key, url, title, author, language, published_at, published_at_claim,
        discovered_at, source_updated_at, timeline_at, backfill, backfill_reason, revision, content_hash, excerpt,
        body_text, body_html, body_status, media, x_post, raw)
      VALUES (${newId}, ${m.sourceId}, ${identityKey}, ${m.url}, ${title}, ${m.author ?? null}, ${m.language ?? null},
        ${t.publishedAt}, ${m.publishedAt ?? null}, ${discoveredAt}, ${m.sourceUpdatedAt ?? null}, ${t.timelineAt},
        ${t.backfill}, ${t.backfillReason}, 1, ${hash}, ${m.excerpt ?? null}, ${m.bodyText ?? null}, ${m.bodyHtml ?? null},
        ${m.bodyStatus ?? (m.bodyText ? "ok" : "pending")}, ${db.json((m.media ?? []) as never)},
        ${m.xPost ? db.json(m.xPost as never) : null}, ${m.raw === undefined ? null : db.json(m.raw as never)})
      ON CONFLICT (identity_key) DO NOTHING RETURNING id`;
    if (inserted) {
      await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
               VALUES (${newId}, 1, ${hash}, ${title}, ${m.bodyText ?? null})`;
      await db`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at)
               VALUES (${newId}, ${m.sourceId}, ${m.via}, ${discoveredAt}) ON CONFLICT DO NOTHING`;
      await reconcileMaterialSource(db, newId, { sourceId: m.sourceId, author: m.author });
      return { articleId: newId, created: true, revised: false, backfill: t.backfill };
    }
    existing = await lockMaterial(db, identityKey);
  }
  await db`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at)
           VALUES (${existing!.id}, ${m.sourceId}, ${m.via}, ${discoveredAt}) ON CONFLICT DO NOTHING`;
  const unchanged: MaterialResult = { articleId: existing!.id, created: false, revised: false, backfill: existing!.backfill };
  // Configuration may have gained a verified publisher since this same discovery channel last
  // saw the URL. Reconcile before accepting any of that channel's material changes.
  if (await reconcileMaterialSource(db, existing!.id, { sourceId: m.sourceId, author: m.author })) {
    if (existing!.participation_mode !== "editorial") {
      const [pending] = await db`SELECT 1 FROM articles a JOIN sources s ON s.id = a.source_id
        WHERE a.id = ${existing!.id} AND s.participation_mode = 'editorial'
          AND NOT EXISTS (SELECT 1 FROM analyses an WHERE an.article_id = a.id AND an.input_revision = a.revision AND an.relevance IS NOT NULL)`;
      if (pending) unchanged.processingNeeded = true;
    }
    return unchanged;
  }
  // Another source listing the same material (an aggregator, a translated mirror, a hot signal) is a
  // discovery only: its title and summary are its own rendering, and taking them made the article flip
  // between the two sources' versions on every fetch. Only the article's own source revises it.
  if (existing!.source_id !== m.sourceId) {
    return unchanged;
  }
  const time = existing!.published_at ? null : await fillPublicationTime(db, existing!.id, m.publishedAt);
  // What the row will hold after this report: a listing without body keeps the stored (extracted) body.
  const bodyText = m.bodyText ?? existing!.body_text;
  const excerpt = m.excerpt ?? existing!.excerpt;
  const next = contentHash({ title, bodyText, excerpt });
  if (!time && existing!.content_hash === next) return unchanged;
  if (!time && existing!.content_hash === null) {
    // Imported history carries no hash of this form (its collectors normalised differently): the
    // first report here records the baseline instead of a revision, so an import does not send
    // every article a source still lists back to paid analysis. The baseline joins the history, so
    // a later return to it is recognised as a version seen before.
    await db`UPDATE articles SET content_hash = ${next}, excerpt = coalesce(excerpt, ${m.excerpt ?? null}) WHERE id = ${existing!.id}`;
    await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${existing!.id}, ${existing!.revision}, ${next}, ${title}, ${bodyText}) ON CONFLICT DO NOTHING`;
    return unchanged;
  }
  // A version this article already had is no new material (listings that alternate between two
  // renderings, pages that rotate promotions): the current revision was analysed and published once
  // already. Any earlier version counts, however long ago: a rotation with many variants would
  // otherwise start over, and a real edit reverted later is rare and loses nothing.
  const [seen] = await db`SELECT 1 FROM article_revisions WHERE article_id = ${existing!.id} AND content_hash = ${next} LIMIT 1`;
  if (!time && seen) return unchanged;
  // Nor is the stored version with other characters lost in transit, or with them restored.
  if (!time && sameBarringLoss(existing!.title, title) && sameBarringLoss(existing!.body_text, bodyText) && sameBarringLoss(existing!.excerpt, excerpt)) return unchanged;

  const media = m.media ? sql.json(m.media as never) : null;
  await reviseMaterial(db, existing!.id, {
    set: sql`title = ${title}, author = coalesce(${m.author ?? null}, author), language = coalesce(${m.language ?? null}, language),
      source_updated_at = ${m.sourceUpdatedAt ?? null}, excerpt = coalesce(${m.excerpt ?? null}, excerpt),
      body_text = coalesce(${m.bodyText ?? null}, body_text), body_html = coalesce(${m.bodyHtml ?? null}, body_html),
      body_status = CASE WHEN ${m.bodyText ?? null}::text IS NULL THEN body_status ELSE ${m.bodyStatus ?? "ok"} END,
      media = CASE WHEN ${media}::jsonb IS NULL THEN media ELSE ${media}::jsonb END,
      x_post = coalesce(${m.xPost ? sql.json(m.xPost as never) : null}, x_post)`,
    hash: next, title, bodyText,
  });
  return { articleId: existing!.id, created: false, revised: true, backfill: time?.backfill ?? existing!.backfill };
}

/**
 * A new revision of stored material, from a report or from body extraction: `set` writes the new
 * content, and everything decided on the old content starts over (analysis and its retry count,
 * grouping, the "adds value" check). The caller holds the row lock and has found the content changed.
 */
export async function reviseMaterial(db: Db, articleId: string, revision: { set: ReturnType<typeof sql>; hash: string; title: string; bodyText: string | null }): Promise<void> {
  const [row] = await db<{ revision: number }[]>`
    UPDATE articles SET ${revision.set}, revision = revision + 1, content_hash = ${revision.hash}, ${groupingReset()},
      processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL, processing_queued_at = NULL,
      updated_at = now()
    WHERE id = ${articleId}
    RETURNING revision`;
  await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
           VALUES (${articleId}, ${row!.revision}, ${revision.hash}, ${revision.title}, ${revision.bodyText})`;
  // Only withdraw an existing projection; the first publication still belongs to completed analysis.
  if ((await db`SELECT 1 FROM publications WHERE article_id = ${articleId}`).length) {
    const published = await publishArticleTx(db as Tx, articleId);
    await emit("articleChanged", { id: articleId, kind: "content", reduced: published?.reduced, reason: "material revision" }, db);
  }
}
