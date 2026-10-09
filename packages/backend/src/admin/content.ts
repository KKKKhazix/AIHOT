// Content diagnostics and corrections. Find any item by id, URL or title and see its whole
// chain: source → discoveries → revisions → model receipts → decisions → publication and sync
// ledger → grouping → deliveries. Visibility changes and manual corrections go through editorial
// overrides with a version check, are re-projected to every public exit, and are audited.
import { z } from "zod";
import { correctReportClassification } from "../reports/correct.ts";
import type { AdminContentChain, AdminContentRow, AdminPublication, BeforeJson } from "@aihot/contracts/admin";
import { ARTICLE_ID_PATTERN, CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { sql, type Tx } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { identityKeyForUrl, normalizeUrl } from "../lib/url.ts";
import { publishArticleTx, setSeoDecision } from "../publication/publish.ts";
import { emit } from "../modules.ts";
import { requestRegroup } from "../events/corrections.ts";
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
  updated_at: Date;
}

/** A reviewed historical date correction; independent discovery order and editorial state are retained. */
export function publicationDateCorrectionPlan(article: PublicationDateMaterial, publishedAt: string, now = Date.now()) {
  const date = new Date(publishedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== publishedAt) throw new Error("发布时间必须是完整、有效的 UTC ISO 日期");
  if (date.getTime() > now) throw new Error("发布时间不能是未来日期");
  const recent = now - 7 * 86400_000;
  if (!article.published_at || article.published_at.getTime() >= recent || date.getTime() >= recent) throw new Error("这里只校正新旧日期均早于七天窗口的历史内容");
  const before = { publishedAt: article.published_at.toISOString(), publishedAtClaim: article.published_at_claim?.toISOString() ?? null,
    timelineAt: article.timeline_at.toISOString() };
  const timelineFollowsPublication = before.timelineAt === before.publishedAt;
  const after = { publishedAt, publishedAtClaim: publishedAt, timelineAt: timelineFollowsPublication ? publishedAt : before.timelineAt };
  const hash = sha256(stableJson({ id: article.id, identity: article.identity_key, source: article.source_id, url: article.url,
    version: article.revision, contentHash: article.content_hash, updatedAt: article.updated_at,
    discoveredAt: article.discovered_at, backfill: article.backfill, backfillReason: article.backfill_reason, before, requested: publishedAt }));
  return { articleId: article.id, version: article.revision, hash, before, after, timelineFollowsPublication,
    changed: before.publishedAt !== publishedAt };
}

/** Read-only plan for the operator's evidence and exact version/hash approval. */
export async function previewPublicationDateCorrection(id: string, publishedAt: string) {
  const [article] = await sql<PublicationDateMaterial[]>`SELECT * FROM articles WHERE id=${id}`;
  return article ? publicationDateCorrectionPlan(article, publishedAt) : null;
}

interface PublicationDateCorrectionResult {
  articleId: string;
  revision: number;
  status: "corrected" | "unchanged";
  publishedAt: string;
}

/** Corrects verified historical metadata without revising material, buying analysis or changing selection. */
export async function correctPublicationDate(id: string, input: { version: number; hash: string; publishedAt: string; requestId: string; reason: string }, actor: string): Promise<PublicationDateCorrectionResult> {
  z.object({ version: z.number().int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/), publishedAt: z.string(),
    requestId: z.string().regex(/^[\w-]{8,80}$/), reason: z.string().trim().min(1) }).parse(input);
  return sql.begin(async tx => {
    const [article] = await tx<PublicationDateMaterial[]>`SELECT * FROM articles WHERE id=${id} FOR UPDATE`;
    if (!article) throw new Conflict("内容不存在");
    const [prior] = await tx<{ after: { publishedAt: string; result: PublicationDateCorrectionResult } }[]>`
      SELECT after FROM audit_log WHERE subject=${`content:${id}`} AND action='content.correct-publication-date'
        AND actor=${actor} AND request_id=${input.requestId} ORDER BY id LIMIT 1`;
    if (prior) {
      if (prior.after.publishedAt !== input.publishedAt) throw new Conflict("同一个请求不能批准不同的发布时间");
      return prior.after.result;
    }
    const plan = publicationDateCorrectionPlan(article, input.publishedAt);
    if (article.revision !== input.version || plan.hash !== input.hash) throw new Conflict("材料或日期已被修改，请重新核对日期校正预览");
    if (!plan.changed) return { articleId: id, revision: article.revision, status: "unchanged", publishedAt: input.publishedAt };
    // Everything except date/order and freshness metadata must be identical after projection.
    const [previous] = await tx<{ decision: unknown }[]>`SELECT to_jsonb(p)-ARRAY['published_at','timeline_at','sort_at','revision','updated_at'] AS decision FROM publications p WHERE article_id=${id}`;
    await tx`UPDATE articles SET published_at=${new Date(plan.after.publishedAt)},published_at_claim=${new Date(plan.after.publishedAtClaim)},
      timeline_at=${new Date(plan.after.timelineAt)},updated_at=now() WHERE id=${id}`;
    if (previous) {
      await publishArticleTx(tx, id);
      const [next] = await tx<{ decision: unknown }[]>`SELECT to_jsonb(p)-ARRAY['published_at','timeline_at','sort_at','revision','updated_at'] AS decision FROM publications p WHERE article_id=${id}`;
      if (stableJson(previous.decision) !== stableJson(next?.decision)) {
        const old = previous.decision as Record<string, unknown>;
        const fresh = (next?.decision ?? {}) as Record<string, unknown>;
        const changed = Object.keys(old).filter(key => stableJson(old[key]) !== stableJson(fresh[key]));
        throw new Conflict(`公开决定已变化，日期校正不能改变选稿、范围、内容或归组：${changed.join("、")}`);
      }
    }
    await emit("articleChanged", { id, kind: "content", reason: "verified historical publication date corrected" }, tx);
    const result: PublicationDateCorrectionResult = { articleId: id, revision: article.revision, status: "corrected", publishedAt: input.publishedAt };
    await audit(actor, "content.correct-publication-date", `content:${id}`, input.reason, plan.before,
      { ...plan.after, result }, { db: tx, requestId: input.requestId });
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
  if (url) return read(sql`a.url IN (${term}, ${url}) OR a.identity_key IN (${identityKeyForUrl(term)}, ${identityKeyForUrl(term, { keepFragment: true })})`);
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
export async function rerun(id: string, step: "extract" | "analyze" | "group", requestId: string, actor: string) {
  z.enum(["extract", "analyze", "group"]).parse(step);
  z.string().regex(/^[\w-]{8,80}$/, "a stable request id is required").parse(requestId);
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
