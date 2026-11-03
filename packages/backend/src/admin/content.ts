// Content diagnostics and corrections. Find any item by id, URL or title and see its whole
// chain: source → discoveries → revisions → model receipts → decisions → publication and sync
// ledger → grouping → deliveries. Visibility changes and manual corrections go through editorial
// overrides with a version check, are re-projected to every public exit, and are audited.
import { z } from "zod";
import { correctReportClassification } from "../reports/correct.ts";
import type { AdminContentChain, AdminContentRow, AdminPublication, AdminPresentationRefresh, AdminRerun, BeforeJson } from "@aihot/contracts/admin";
import { ARTICLE_ID_PATTERN, CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { sql, type Db, type Tx } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { needsGrouping, queueProcessing } from "../jobs/content.ts";
import { identityKeyForUrl, normalizeUrl } from "../lib/url.ts";
import { publishArticleTx, setSeoDecision } from "../publication/publish.ts";
import { emit } from "../modules.ts";
import { requestRegroup } from "../events/corrections.ts";
import { resetAutomatic } from "../events/group.ts";
import { materialIdentityForUrl, contentHash, decideTimeline, explicitBackfill, isHistorical, updatePresentation, type MediaItem } from "../content/materials.ts";
import { extractFromUrl, pageFetchable, pageRules } from "../content/extract.ts";
import { PresentationMismatch, presentationCounts, rebaseTranslation } from "../content/presentation.ts";
import { fetchRss } from "../sources/rss.ts";
import { listingEntries, loadSource } from "../sources/collect.ts";
import type { SourceRow } from "../sources/types.ts";
import { computeHotRanking, storedHotRanking } from "../events/hot.ts";
import { audit, auditHistory, Conflict } from "../audit.ts";
import { sha256, stableJson } from "../lib/ids.ts";

interface PublicationDateMaterial {
  id: string;
  identity_key: string;
  source_id: string;
  url: string;
  revision: number;
  content_hash: string | null;
  published_at: Date | null;
  published_at_claim: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  backfill_reason: string | null;
  processing_state: string;
  grouping_status: string;
  updated_at: Date;
  participation_mode: string;
}

const material = (db: Db, id: string, lock: boolean) => db<PublicationDateMaterial[]>`
  SELECT a.*, s.participation_mode FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${id} ${lock ? db`FOR UPDATE OF a` : db``}`;

/** Dates within this window are recent; older ones are history's to correct. */
const RECENT_MS = 7 * 86400_000;

interface DatedFields { publishedAt: string | null; publishedAtClaim: string | null; timelineAt: string; backfill: boolean; backfillReason: string | null }

/**
 * An old date replaced by an older verified one keeps every decision of the material, history or not:
 * its discovery time may be an import's estimate, so the date is not judged against it. The sort
 * follows only where it was that date.
 */
function historicalDate(article: PublicationDateMaterial, published: Date, date: Date, now: number): DatedFields {
  if (date.getTime() >= now - RECENT_MS) throw new Error("历史日期校正的真实发布时间须早于七天窗口");
  const iso = date.toISOString();
  const timelineAt = article.timeline_at.getTime() === published.getTime() ? iso : article.timeline_at.toISOString();
  return { publishedAt: iso, publishedAtClaim: iso, timelineAt, backfill: article.backfill, backfillReason: article.backfill_reason };
}

/**
 * News gets its verified date, or loses an untrusted one, through the timeline rule against its first
 * discovery; a first import or reported backfill keeps that nature. `archive`: the new date makes it
 * history, so it leaves automatic events and heat.
 */
function liveDate(article: PublicationDateMaterial, date: Date | null): { after: DatedFields; archive: boolean } {
  if (isHistorical(article)) throw new Error(date ? "近期日期只校正刚收录的非历史内容" : "历史内容只校正有明确原文证据的日期");
  const t = decideTimeline(date, article.discovered_at, explicitBackfill(article.backfill_reason));
  if (date && !t.publishedAt) throw new Error("发布时间超过首次收录的一小时容差，不能据此校正");
  const iso = t.publishedAt?.toISOString() ?? null;
  return {
    after: { publishedAt: iso, publishedAtClaim: iso, timelineAt: t.timelineAt.toISOString(), backfill: t.backfill, backfillReason: t.backfillReason },
    archive: isHistorical({ backfill: t.backfill, published_at: t.publishedAt, discovered_at: article.discovered_at }),
  };
}

/**
 * Correct a verified date, or retract an untrusted live one (null). Replacing a date from before the
 * recent window with another is history's correction (historicalDate); anything else is news (liveDate).
 */
export function publicationDateCorrectionPlan(article: PublicationDateMaterial, publishedAt: string | null, now = Date.now()) {
  const date = publishedAt === null ? null : new Date(publishedAt);
  if (date && (!Number.isFinite(date.getTime()) || date.toISOString() !== publishedAt)) throw new Error("发布时间必须是完整、有效的 UTC ISO 日期");
  if (date && date.getTime() > now) throw new Error("发布时间不能是未来日期");
  const published = article.published_at;
  if (!published) throw new Error("只校正有既有日期的内容");
  const before: DatedFields = { publishedAt: published.toISOString(), publishedAtClaim: article.published_at_claim?.toISOString() ?? null,
    timelineAt: article.timeline_at.toISOString(), backfill: article.backfill, backfillReason: article.backfill_reason };
  const { mode, after, archive } = date && published.getTime() < now - RECENT_MS
    ? { mode: "history" as const, after: historicalDate(article, published, date, now), archive: false }
    : { mode: "live" as const, ...liveDate(article, date) };
  const hash = sha256(stableJson({ id: article.id, identity: article.identity_key, source: article.source_id, url: article.url,
    version: article.revision, contentHash: article.content_hash, updatedAt: article.updated_at,
    discoveredAt: article.discovered_at, backfill: article.backfill, backfillReason: article.backfill_reason, before, requested: publishedAt }));
  return { articleId: article.id, version: article.revision, hash, mode, before, after, archive, changed: before.publishedAt !== publishedAt };
}

/** Read-only plan for the operator's evidence and exact version/hash approval. */
export async function previewPublicationDateCorrection(id: string, publishedAt: string | null) {
  const [article] = await material(sql, id, false);
  return article ? publicationDateCorrectionPlan(article, publishedAt) : null;
}

/**
 * Processing has ended: judged or skipped, and grouped where the pipeline groups such material. A
 * running processor's result is still bound to this revision, so news waits for it.
 */
async function processingSettled(tx: Tx, a: PublicationDateMaterial): Promise<boolean> {
  if (!["analyzed", "blocked", "skipped"].includes(a.processing_state)) return false;
  if (a.grouping_status === "complete") return true;
  const [analysis] = await tx<{ relevance: string | null }[]>`SELECT relevance FROM analyses
    WHERE article_id=${a.id} AND input_revision=${a.revision} ORDER BY id DESC LIMIT 1`;
  return !needsGrouping({ participationMode: a.participation_mode, historical: isHistorical(a), relevance: analysis?.relevance });
}

interface PublicationDateCorrectionResult {
  articleId: string;
  revision: number;
  status: "corrected" | "unchanged";
  publishedAt: string | null;
}

/** Correct or retract dates without revising material or buying analysis; archived news leaves automatic events. */
export async function correctPublicationDate(id: string, input: { version: number; hash: string; publishedAt: string | null; requestId: string; reason: string }, actor: string): Promise<PublicationDateCorrectionResult> {
  z.object({ version: z.number().int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/), publishedAt: z.string().nullable(),
    requestId: z.string().regex(/^[\w-]{8,80}$/), reason: z.string().trim().min(1) }).parse(input);
  return sql.begin(async tx => {
    const [article] = await material(tx, id, true);
    if (!article) throw new Conflict("内容不存在");
    const [prior] = await tx<{ after: { publishedAt: string | null; result: PublicationDateCorrectionResult } }[]>`
      SELECT after FROM audit_log WHERE subject=${`content:${id}`} AND action='content.correct-publication-date'
        AND actor=${actor} AND request_id=${input.requestId} ORDER BY id LIMIT 1`;
    if (prior) {
      if (prior.after.publishedAt !== input.publishedAt) throw new Conflict("同一个请求不能批准不同的发布时间");
      return prior.after.result;
    }
    const plan = publicationDateCorrectionPlan(article, input.publishedAt);
    if (article.revision !== input.version || plan.hash !== input.hash) throw new Conflict("材料或日期已被修改，请重新核对日期校正预览");
    if (!plan.changed) return { articleId: id, revision: article.revision, status: "unchanged", publishedAt: input.publishedAt };
    if (plan.mode === "live" && !(await processingSettled(tx, article))) throw new Conflict("内容仍在处理中，请处理结束后重新核对日期");
    let previousStoryIds: number[] = [];
    if (plan.archive) {
      // An editor's grouping is never discarded by date repair.
      const [manual] = await tx`SELECT 1 FROM grouping_overrides WHERE article_id=${id}
        UNION ALL SELECT 1 FROM fact_articles WHERE article_id=${id} AND manual LIMIT 1`;
      if (manual) throw new Conflict("这条内容有人工归组，请先核对其归属");
      previousStoryIds = await resetAutomatic(tx, id);
      for (const storyId of previousStoryIds) await enqueue(QUEUES.digest, { storyId }, { singletonKey: `story:${storyId}` }, tx);
    }
    // Every editorial decision is kept; archiving also changes freshness and the automatic event projection.
    const [previous] = await tx<{ decision: unknown }[]>`SELECT to_jsonb(p)-ARRAY['published_at','timeline_at','sort_at','revision','updated_at'] AS decision FROM publications p WHERE article_id=${id}`;
    await tx`UPDATE articles SET publication_time=${plan.after.publishedAt},published_at=${plan.after.publishedAt === null ? null : new Date(plan.after.publishedAt)},published_at_claim=${plan.after.publishedAtClaim === null ? null : new Date(plan.after.publishedAtClaim)},
      timeline_at=${new Date(plan.after.timelineAt)},backfill=${plan.after.backfill},backfill_reason=${plan.after.backfillReason},updated_at=now() WHERE id=${id}`;
    if (previous) {
      await publishArticleTx(tx, id);
      const [next] = await tx<{ decision: unknown }[]>`SELECT to_jsonb(p)-ARRAY['published_at','timeline_at','sort_at','revision','updated_at'] AS decision FROM publications p WHERE article_id=${id}`;
      if (!plan.archive && stableJson(previous.decision) !== stableJson(next?.decision)) {
        const old = previous.decision as Record<string, unknown>;
        const fresh = (next?.decision ?? {}) as Record<string, unknown>;
        const changed = Object.keys(old).filter(key => stableJson(old[key]) !== stableJson(fresh[key]));
        throw new Conflict(`公开决定已变化，日期校正不能改变选稿、范围、内容或归组：${changed.join("、")}`);
      }
    }
    await emit("articleChanged", { id, kind: "content", reduced: plan.archive,
      previousStoryIds, reason: "publication date corrected" }, tx);
    const result: PublicationDateCorrectionResult = { articleId: id, revision: article.revision, status: "corrected", publishedAt: input.publishedAt };
    await audit(actor, "content.correct-publication-date", `content:${id}`, input.reason, plan.before,
      { ...plan.after, previousStoryIds, result }, { db: tx, requestId: input.requestId });
    return result;
  });
}

export async function searchContent(q: string): Promise<BeforeJson<AdminContentRow>[]> {
  const term = q.trim();
  if (!term) return [];
  const read = (where: ReturnType<typeof sql>) => sql<BeforeJson<AdminContentRow>[]>`
    SELECT a.id, coalesce(p.title, a.title) AS title, a.url, s.name AS source, a.discovered_at, a.processing_state,
           p.visibility, p.selected, p.score
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    WHERE ${where} ORDER BY a.discovered_at DESC, a.id LIMIT 50`;
  // Exact lookups use the identity indexes; a title search must not force a full-table join for an ID.
  if (ARTICLE_ID_PATTERN.test(term)) {
    const found = await read(sql`a.id = ${term}`);
    if (found.length) return found;
  }
  const url = /^https?:\/\//i.test(term) ? normalizeUrl(term) : null;
  if (url) return read(sql`a.url IN (${term}, ${url}) OR a.identity_key IN (${await materialIdentityForUrl(term)}, ${identityKeyForUrl(term, { keepFragment: true })})`);
  return read(sql`a.title ILIKE ${`%${term}%`} OR p.title ILIKE ${`%${term}%`}`);
}

type Chain = BeforeJson<AdminContentChain>;

export async function contentChain(id: string): Promise<Chain | null> {
  const [article] = await sql<Chain["article"][]>`
    SELECT a.id, a.source_id, a.url, a.identity_key, a.title, a.author, a.language, a.published_at, a.published_at_claim, a.discovered_at,
           a.timeline_at, a.backfill, a.body_status, a.revision, a.processing_state, a.processing_error, a.grouped_at, length(a.body_text) AS body_chars,
           s.name AS source_name, s.kind AS source_kind, s.tier, s.participation_mode, s.site_fulltext, s.syndicate_fulltext
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${id}`;
  if (!article) return null;
  const [discoveries, revisions, analyses, publication, override, ledger, membership, decisions, deliveries, history] = await Promise.all([
    sql<Chain["discoveries"]>`SELECT source_id, via, discovered_at FROM article_discoveries WHERE article_id = ${id} ORDER BY discovered_at`,
    sql<Chain["revisions"]>`SELECT revision, title, content_hash, created_at FROM article_revisions WHERE article_id = ${id} ORDER BY revision DESC LIMIT 10`,
    sql<Chain["analyses"]>`
      SELECT an.id, an.origin, an.model, an.prompt_version, an.input_revision, an.relevance, an.category, an.score, an.selected, an.title_zh, an.reason_zh,
             an.created_at,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'service', r.service, 'model', r.model, 'cost', r.cost, 'at', r.created_at) ORDER BY r.id), '[]'::jsonb)
                FROM receipts r WHERE r.id = ANY(an.receipt_ids)) AS receipts
      FROM analyses an WHERE an.article_id = ${id} ORDER BY an.created_at DESC LIMIT 10`,
    sql<BeforeJson<AdminPublication>[]>`SELECT * FROM publications WHERE article_id = ${id}`,
    sql<NonNullable<Chain["override"]>[]>`SELECT fields, visibility, reason, version, updated_by, updated_at FROM editorial_overrides WHERE article_id = ${id}`,
    sql<Chain["ledger"]>`SELECT seq, op, visible_at, changed_at FROM selected_ledger WHERE article_id = ${id} ORDER BY seq DESC LIMIT 10`,
    sql<Chain["membership"]>`
      SELECT fa.fact_id, fa.role, fa.manual, f.public_id AS fact_public_id, f.title AS fact_title, st.id AS story_id, st.public_id AS story_public_id, st.title AS story_title
      FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id LEFT JOIN stories st ON st.id = f.story_id WHERE fa.article_id = ${id}`,
    sql<Chain["decisions"]>`SELECT verdict, fact_id, story_id, receipt_id, candidates, created_at FROM grouping_decisions WHERE article_id = ${id} ORDER BY created_at DESC LIMIT 5`,
    sql<Chain["deliveries"]>`SELECT target_key, dedupe_key, status, attempts, response, created_at, sent_at FROM deliveries WHERE subject_id = ${id} ORDER BY created_at DESC`,
    auditHistory(`content:${id}`),
  ]);
  return { article, discoveries, revisions, analyses, publication: publication[0] ?? null, override: override[0] ?? null, ledger, membership, decisions, deliveries, history };
}

/** Whether the current hot ranking shows the article: as an event's representative or among its reports. */
async function inHotRanking(id: string, tx: Tx): Promise<boolean> {
  const ranking = await storedHotRanking(tx);
  if (!ranking?.entries.length) return false;
  if (ranking.entries.some((e) => e.representativeItemId === id)) return true;
  const [p] = await tx<{ story_id: number | null }[]>`SELECT story_id FROM publications WHERE article_id = ${id}`;
  return !!p?.story_id && ranking.entries.some((e) => e.storyId === Number(p.story_id));
}

const STALE = "这条内容的人工设置已被修改，请刷新后再操作";

async function overrideRow(id: string, tx: Tx) {
  // Use the same first lock as publication and automatic processing, including the first correction.
  const [article] = await tx`SELECT id FROM articles WHERE id = ${id} FOR UPDATE`;
  if (!article) throw Object.assign(new Error("内容不存在"), { statusCode: 400 });
  const [o] = await tx<{ fields: Record<string, unknown>; visibility: string | null; version: number }[]>`SELECT fields, visibility, version FROM editorial_overrides WHERE article_id = ${id}`;
  return o ?? { fields: {}, visibility: null, version: 0 };
}

/**
 * Public / summary-only / withdrawn. Applies to the site, API, RSS, MCP, the sync ledger and the
 * search index through the one publication projection; ETags change with the content.
 */
export async function setVisibility(id: string, input: { visibility: "public" | "summary-only" | "withdrawn"; reason: string; version: number }, actor: string) {
  z.object({ visibility: z.enum(["public", "summary-only", "withdrawn"]), reason: z.string().trim().min(1), version: z.number().int().nonnegative() }).parse(input);
  const { hot, published } = await sql.begin(async (tx) => {
    const before = await overrideRow(id, tx);
    if (before.version !== input.version) throw new Conflict(STALE);
    await tx`
      INSERT INTO editorial_overrides (article_id, visibility, reason, version, updated_by) VALUES (${id}, ${input.visibility}, ${input.reason}, 1, ${actor})
      ON CONFLICT (article_id) DO UPDATE SET visibility = EXCLUDED.visibility, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    const published = await publishArticleTx(tx, id);
    let hot = false;
    if (published?.reduced || (before.visibility ?? "public") !== input.visibility) {
      hot = await inHotRanking(id, tx);
      await emit("articleChanged", { id, kind: "content", reduced: published?.reduced, reason: `visibility ${input.visibility}` }, tx);
      const stories = await tx<{ story_id: number }[]>`
        SELECT DISTINCT f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE fa.article_id = ${id} AND f.story_id IS NOT NULL`;
      for (const s of stories) await enqueue(QUEUES.digest, { storyId: s.story_id }, { singletonKey: `story:${s.story_id}` }, tx);
    }
    await audit(actor, "content.visibility", `content:${id}`, input.reason, { visibility: before.visibility }, { visibility: input.visibility }, { db: tx });
    return { hot, published };
  });
  // Ranking reads committed publications; until this completes, its public reader checks live scope.
  if (hot) await computeHotRanking();
  return published;
}

/** Marks a detail page for search indexing (sitemap, IndexNow, robots) or removes the mark. */
export async function setSeoIndexed(id: string, input: { indexed: boolean; reason: string }, actor: string) {
  z.object({ indexed: z.boolean(), reason: z.string().trim().min(1) }).parse(input);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM articles WHERE id = ${id} FOR UPDATE`;
    const [before] = await tx<{ indexable: boolean }[]>`SELECT indexable FROM publications WHERE article_id = ${id}`;
    if (!before) return null;
    const published = await setSeoDecision(tx, id, input.indexed);
    await audit(actor, "content.seo", `content:${id}`, input.reason, { indexed: before.indexable }, { indexed: input.indexed }, { db: tx });
    return published;
  });
}

const FieldsSchema = z
  .object({
    title: z.string().min(1).max(300),
    summary: z.string().max(2000),
    reason: z.string().max(1000),
    category: z.enum(CATEGORY_KEYS as unknown as [string, ...string[]]),
    tags: z.array(z.string().max(60)).max(20),
    score: z.number().min(0).max(100).nullable(),
    selected: z.boolean(),
    silent: z.boolean(),
  })
  .partial()
  .strict();

/** Manual corrections win over model output; `clear` removes a correction. */
export async function overrideFields(id: string, input: { fields: unknown; clear?: string[]; reason: string; version: number }, actor: string) {
  z.object({ reason: z.string().trim().min(1), version: z.number().int().nonnegative(), clear: z.array(z.string()).optional() }).parse(input);
  const fields = FieldsSchema.parse(input.fields ?? {});
  const published = await sql.begin(async (tx) => {
    const before = await overrideRow(id, tx);
    if (before.version !== input.version) throw new Conflict(STALE);
    const next: Record<string, unknown> = { ...before.fields, ...fields };
    for (const k of input.clear ?? []) delete next[k];
    await tx`
      INSERT INTO editorial_overrides (article_id, fields, reason, version, updated_by) VALUES (${id}, ${tx.json(next as never)}, ${input.reason}, 1, ${actor})
      ON CONFLICT (article_id) DO UPDATE SET fields = EXCLUDED.fields, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    const published = await publishArticleTx(tx, id);
    if (published?.changed) {
      await emit("articleChanged", { id, kind: "content", reduced: published.reduced, reason: "manual correction" }, tx);
      const changedFields = new Set([...Object.keys(fields), ...(input.clear ?? [])]);
      if (changedFields.has("category") || changedFields.has("tags")) await correctReportClassification(tx, id, input.reason);
      const [st] = await tx<{ story_id: number | null }[]>`SELECT story_id FROM publications WHERE article_id = ${id}`;
      if (st?.story_id && [...changedFields].some(k => k !== "category" && k !== "tags")) {
        await enqueue(QUEUES.digest, { storyId: st.story_id }, { singletonKey: `story:${st.story_id}` }, tx);
      }
    }
    await audit(actor, "content.override", `content:${id}`, input.reason, before.fields, next, { db: tx });
    return published;
  });
  return published;
}

/**
 * Re-runs a pipeline step for the current revision. Re-evaluation is a new paid model call bound to
 * the request id, so submitting the same request twice neither enqueues nor pays twice.
 */
export function rerun(id: string, step: "presentation", requestId: string, actor: string, options: Pick<AdminRerun, "preview" | "version">): Promise<AdminPresentationRefresh | null>;
export function rerun(id: string, step: "extract" | "analyze" | "group", requestId: string, actor: string): Promise<{ jobId: string | null } | null>;
export function rerun(id: string, step: AdminRerun["step"], requestId: string, actor: string, options: Pick<AdminRerun, "preview" | "version">): Promise<AdminPresentationRefresh | { jobId: string | null } | null>;
export async function rerun(id: string, step: AdminRerun["step"], requestId: string, actor: string, options: Pick<AdminRerun, "preview" | "version"> = {}) {
  z.enum(["extract", "analyze", "group", "presentation"]).parse(step);
  z.string().regex(/^[\w-]{8,80}$/, "a stable request id is required").parse(requestId);
  if (step === "presentation") return refreshPresentation(id, options, requestId, actor);
  return sql.begin(async (tx) => {
    const [a] = await tx`SELECT id FROM articles WHERE id = ${id} FOR UPDATE`;
    if (!a) return null;
    // Queue singleton keys expire when a job completes. The committed command remains in the audit.
    const [prior] = await tx<{ after: { jobId: string | null } }[]>`
      SELECT after FROM audit_log WHERE subject = ${`content:${id}`} AND action = ${`content.rerun.${step}`}
        AND actor = ${actor} AND request_id = ${requestId} ORDER BY id DESC LIMIT 1`;
    if (prior) return { jobId: prior.after.jobId };
    let jobId: string | null;
    if (step === "group") jobId = await requestRegroup(id, requestId, tx);
    else {
      await tx`UPDATE articles SET processing_state = 'new', processing_error = NULL, processing_attempts = 0, processing_retry_at = NULL,
                  body_status = CASE WHEN ${step === "extract"} THEN 'pending' ELSE body_status END WHERE id = ${id}`;
      jobId = await queueProcessing(id, { step, ...(step === "analyze" ? { attemptTag: `admin:${requestId}` } : {}), db: tx });
    }
    await audit(actor, `content.rerun.${step}`, `content:${id}`, null, null, { jobId, requestId }, { requestId, db: tx });
    return { jobId };
  });
}

async function presentationSnapshot(id: string, db: Db = sql, lock = false) {
  const [a] = await db<{ revision: number; title: string; body_text: string | null; excerpt: string | null; body_html: string | null; media: MediaItem[];
    source_id: string; identity_key: string; url: string; kind: string; config: SourceRow["config"]; tr_html: string | null; tr_origin: string | null }[]>`
    SELECT a.revision,a.title,a.body_text,a.excerpt,a.body_html,a.media,a.source_id,a.identity_key,a.url,s.kind,s.config,
      tr.body_html AS tr_html,tr.origin AS tr_origin
    FROM articles a JOIN sources s ON s.id=a.source_id
    LEFT JOIN translations tr ON tr.article_id=a.id AND tr.lang='zh' AND tr.revision=a.revision
    WHERE a.id=${id} ${lock ? sql`FOR UPDATE OF a` : sql``}`;
  return a;
}

/** Preview and apply through the existing audited command, without analysis, date changes or paid extraction. */
async function refreshPresentation(id: string, options: Pick<AdminRerun, "preview" | "version">, requestId: string, actor: string): Promise<AdminPresentationRefresh | null> {
  const input = z.object({ preview: z.boolean().optional(), version: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(options);
  if (!input.preview && !input.version) throw new Conflict("请先预览正文展示变化");
  if (!input.preview) {
    const [prior] = await sql<{ after: { result: AdminPresentationRefresh } }[]>`SELECT after FROM audit_log
      WHERE subject=${`content:${id}`} AND action='content.rerun.presentation' AND actor=${actor} AND request_id=${requestId} ORDER BY id DESC LIMIT 1`;
    if (prior) return prior.after.result;
  }
  const a = await presentationSnapshot(id);
  if (!a) return null;
  // A feed can publish different wording from its web page. Refresh the same source material first.
  let got: { html: string; text: string; images: MediaItem[] } | null = null;
  if (a.kind === "rss" && a.config.feedUrl) {
    const source = (await loadSource(a.source_id))!;
    const entries = await listingEntries(source, (await fetchRss(source, { force: true })).candidates);
    const entry = entries.find(c => c.identityKey === a.identity_key);
    if (entry?.bodyHtml && entry.bodyText) got = { html: entry.bodyHtml, text: entry.bodyText, images: entry.media ?? [] };
  }
  if (!got && pageFetchable(a.url, a.kind)) {
    const page = await extractFromUrl(a.url, `article:${id}`, pageRules(a.config), { paidFallback: false });
    // Match normal extraction: the publisher's existing cover has precedence over body images.
    if (page) got = { ...page, images: a.media.length ? a.media : page.images };
  }
  const before = presentationCounts(a.body_html), after = presentationCounts(got?.html ?? a.body_html);
  let reason = !got ? "当前原文未能直接抽取，请使用正常正文抽取处理" :
    contentHash({ title: a.title, bodyText: a.body_text, excerpt: a.excerpt }) !== contentHash({ title: a.title, bodyText: got.text, excerpt: a.excerpt })
      ? "正文文字已经变化，需要正常抽取和评估，不能只刷新展示" : null;
  let translation: AdminPresentationRefresh["translation"] = a.tr_origin === "source" ? "source" : a.tr_html ? "reused" : "absent";
  if (!reason && got && got.html !== a.body_html && a.tr_html && a.tr_origin === "model") {
    try { rebaseTranslation(a.body_html ?? "", got.html, a.tr_html); }
    catch (error) {
      if (!(error instanceof PresentationMismatch)) throw error;
      reason = error.message;
      translation = "blocked";
    }
  }
  const version = sha256(stableJson({ before: a, html: got?.html, media: got?.images }));
  const result: AdminPresentationRefresh = { revision: a.revision, version, ready: reason === null, applied: false,
    changed: !!got && (got.html !== a.body_html || stableJson(got.images) !== stableJson(a.media)), reason,
    images: { before: before.images, after: after.images }, links: { before: before.links, after: after.links }, translation };
  if (input.preview) return result;
  if (input.version !== version) throw new Conflict("正文或原网页在预览后变化，请重新预览");
  if (reason || !got) throw new Conflict(reason ?? "正文未能抽取");
  return sql.begin(async tx => {
    const current = await presentationSnapshot(id, tx, true);
    const [prior] = await tx<{ after: { result: AdminPresentationRefresh } }[]>`SELECT after FROM audit_log
      WHERE subject=${`content:${id}`} AND action='content.rerun.presentation' AND actor=${actor} AND request_id=${requestId} ORDER BY id DESC LIMIT 1`;
    if (prior) return prior.after.result;
    if (stableJson(current) !== stableJson(a)) throw new Conflict("材料在预览后变化，请重新预览");
    await updatePresentation(tx, id, { html: got.html, media: got.images });
    const applied = { ...result, applied: true };
    await audit(actor, "content.rerun.presentation", `content:${id}`, "仅刷新正文展示",
      { revision: a.revision, bodyHtml: a.body_html, media: a.media, translationHtml: a.tr_html },
      { result: applied, bodyHtml: got.html, media: got.images }, { requestId, db: tx });
    return applied;
  });
}
