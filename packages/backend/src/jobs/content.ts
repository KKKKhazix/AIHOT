// Content processing: body extraction when the source needs it → analysis → publish → event grouping.
// Every article reaches the queues through queueProcessing, which records when it was queued. A failed
// step records when to try again, and the sweep (content.sweep) is the timer that queues it then; it
// also queues articles whose job was never created or has waited half an hour. A provider outage makes
// an article wait and retry with backoff; only a permanent refusal or exhausted retries end in
// "failed", which the admin re-queues in bulk.
import type { PgBoss } from "pg-boss";
import { sql, type Db } from "../db.ts";
import { extractArticleBody, pageFetchable } from "../content/extract.ts";
import { analyzeArticle, AnalysisInterruptedError } from "../editorial/analyze.ts";
import { isHistorical } from "../content/materials.ts";
import { publishArticle } from "../publication/publish.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { ModelOutputError } from "../providers/llm.ts";
import { enqueue, QUEUES, shutdownSignal, work } from "./queue.ts";

/** Minutes to wait after the n-th failed attempt; one more failure after the last ends in "failed". */
const RETRY_MINUTES = [5, 10, 20, 40, 60, 120, 240, 360];
/** Unusable model output is retried less: each retry is a paid call. */
const MAX_OUTPUT_FAILURES = 3;
/** Extraction gives up after this many errors and the article is judged on what it has. */
const MAX_EXTRACT_FAILURES = 3;
/** An article queued this long ago is queued again, in case its job was lost. */
const QUEUED_STALE = "30 minutes";

type Step = "extract" | "analyze";

interface Route {
  step: Step;
  /** Not an editorial source: no analysis; the post goes straight to event grouping as discussion evidence. */
  signal: boolean;
  historical: boolean;
}

/**
 * The article's next step: its body first while none is confirmed and the source asks for full text,
 * when there is only a title or a feed summary (the analysis judges the whole article), or when an X
 * post links an X Article (fetched before judging; a discussion post only while it is news, as
 * history adds no heat).
 */
async function route(articleId: string, db: Db): Promise<Route | null> {
  const [row] = await db<{ body_status: string; participation_mode: string; kind: string; config: Record<string, unknown>; url: string; bare: boolean; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    SELECT a.body_status, s.participation_mode, s.kind, s.config, a.url, (coalesce(a.body_text, '') = '' AND a.x_post IS NULL) AS bare,
           a.backfill, a.published_at, a.discovered_at
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!row) return null;
  const historical = isHistorical(row);
  const signal = row.participation_mode !== "editorial";
  const pending = row.body_status === "pending";
  const wantsBody = row.config.fetchPublicContent === true || !!row.config.detail || row.kind === "web_list";
  const needsPage = !signal && pageFetchable(row.url, row.kind) && (wantsBody || row.bare);
  const needsXArticle = row.kind === "x_search" && (!signal || (row.participation_mode === "hot_signal" && !historical));
  return { step: pending && (needsPage || needsXArticle) ? "extract" : "analyze", signal, historical };
}

/**
 * Queue order (pg-boss serves higher priority first): live work before history, so a new source's
 * first import or a backfill never holds up today's news; discussion evidence waits behind reports
 * in the serial grouping queue, history behind both.
 */
const PRIORITY = { live: 0, liveSignal: -1, history: -2 } as const;

/**
 * The one way to hand an article to processing. `attemptTag` makes an explicit re-evaluation a new
 * (paid) request; the same tag reuses its receipt. With `db`, the job commits with the caller's write.
 * Posts of non-editorial sources skip the analysis queue: they only need recording and grouping.
 */
export async function queueProcessing(articleId: string, opts: { step?: Step; attemptTag?: string; db?: Db } = {}): Promise<string | null> {
  const db = opts.db ?? sql;
  const r = await route(articleId, db);
  if (!r) return null;
  const step = opts.step ?? r.step;
  const [queued] = await db<{ processing_attempt_tag: string | null }[]>`
    UPDATE articles SET processing_queued_at = now(), processing_attempt_tag = coalesce(${opts.attemptTag ?? null}, processing_attempt_tag)
    WHERE id = ${articleId} RETURNING processing_attempt_tag`;
  if (!queued) return null;
  // Extraction and the sweep only carry articleId; retain the current evaluation's paid identity.
  const attemptTag = queued.processing_attempt_tag ?? undefined;
  if (step === "extract") return enqueue(QUEUES.extractBody, { articleId }, { singletonKey: articleId, priority: r.historical ? PRIORITY.history : PRIORITY.live }, opts.db);
  if (r.signal && !attemptTag) {
    return enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: r.historical ? PRIORITY.history : PRIORITY.liveSignal }, opts.db);
  }
  const tagged = !!attemptTag;
  return enqueue(QUEUES.analyze, tagged ? { articleId, attemptTag } : { articleId },
    { singletonKey: tagged ? `manual:analyze:${articleId}:${attemptTag}` : articleId, priority: r.historical ? PRIORITY.history : PRIORITY.live }, opts.db);
}

/**
 * A post of a non-editorial source: recorded (hot_signal material only feeds heat; isolated material
 * never reaches public surfaces). Returns whether it is discussion evidence to group.
 */
export async function settleNonEditorial(articleId: string): Promise<{ group: boolean }> {
  const [row] = await sql<{ participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    UPDATE articles a SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
    FROM sources s WHERE s.id = a.source_id AND a.id = ${articleId} AND s.participation_mode <> 'editorial'
    RETURNING s.participation_mode, a.backfill, a.published_at, a.discovered_at`;
  if (!row) return { group: false };
  await publishArticle(articleId);
  return { group: row.participation_mode === "hot_signal" && !isHistorical(row) };
}

async function processingInput(articleId: string) {
  const [row] = await sql<{ participation_mode: string; revision: number; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    SELECT s.participation_mode, a.revision, a.backfill, a.published_at, a.discovered_at FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  return row ? { ...row, historical: isHistorical(row) } : null;
}

/**
 * The analysis job: the article's current revision through analysis and publication; failures wait,
 * retry or end in "failed" (afterFailure). attemptTag makes an explicit re-evaluation a new (paid)
 * request; the same tag reuses its receipt.
 */
export async function processArticle(articleId: string, opts: { attemptTag?: string } = {}): Promise<{ state: string; retryAt?: Date }> {
  const row = await processingInput(articleId);
  if (!row) return { state: "missing" };
  try {
    return await processRevision(articleId, row, opts);
  } catch (error) {
    return afterFailure(articleId, row.revision, error);
  }
}

async function processRevision(articleId: string, row: NonNullable<Awaited<ReturnType<typeof processingInput>>>, opts: { attemptTag?: string }): Promise<{ state: string }> {
  if (row.participation_mode !== "editorial") {
    // Normally queued straight for grouping (queueProcessing); an explicit re-evaluation lands here.
    const { group } = await settleNonEditorial(articleId);
    if (group) await enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: PRIORITY.liveSignal });
    return { state: "skipped" };
  }
  try {
    const result = await analyzeArticle(articleId, { attemptTag: opts.attemptTag });
    if (!result) return { state: "missing" };
    // Only a title or a feed summary: the article page first; extraction queues the analysis again.
    if (result.needsBody || !result.output) {
      await queueProcessing(articleId, { step: "extract" });
      return { state: "fetching-body" };
    }
    if (result.stale) return { state: "stale" }; // the newer revision has its own job
    await publishArticle(articleId);
    // History still completes the identity gate; groupArticle confirms it without a model call.
    if (result.output.relevance === "pass") await enqueue(QUEUES.group, { articleId }, { singletonKey: articleId, priority: row.historical ? PRIORITY.history : PRIORITY.live });
    await sql`UPDATE articles SET processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
              WHERE id = ${articleId} AND revision = ${row.revision}`;
    return { state: result.output.relevance };
  } catch (error) {
    if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
    if (error instanceof ReceiptUnknownError) {
      // The provider may have billed this request: stop; ops.recover releases it once and requeues the article.
      await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${`receipt ${error.receiptId} outcome unknown`}
                WHERE id = ${articleId} AND revision = ${row.revision}`;
      return { state: "unknown-receipt" };
    }
    throw error;
  }
}

/** Waits and retries for passing trouble; marks "failed" for refusals and exhausted retries. */
async function afterFailure(articleId: string, revision: number, error: unknown): Promise<{ state: string; retryAt?: Date }> {
  // Let pg-boss retry this job after restart, reusing settled receipts. A deploy is not an article
  // failure and must neither consume processing_attempts nor turn an incomplete chain terminal.
  if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  if (error instanceof ReceiptBusyError || error instanceof BudgetExceededError) {
    // Not the article's fault: the same request is in flight, or the budget window is full.
    const seconds = error instanceof BudgetExceededError ? error.retryAfterSeconds : 60;
    const retryAt = new Date(Date.now() + seconds * 1000);
    await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_retry_at = ${retryAt}, processing_queued_at = NULL
              WHERE id = ${articleId} AND revision = ${revision}`;
    return { state: "waiting", retryAt };
  }
  const [a] = await sql<{ processing_attempts: number }[]>`SELECT processing_attempts FROM articles WHERE id = ${articleId} AND revision = ${revision}`;
  if (!a) return { state: "stale" };
  const attempts = a.processing_attempts + 1;
  const refused = error instanceof ProviderRejectedError && !error.retryable;
  const exhausted = attempts > RETRY_MINUTES.length || (error instanceof ModelOutputError && attempts >= MAX_OUTPUT_FAILURES);
  if (refused || exhausted) {
    await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${message}, processing_attempts = ${attempts},
                processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId} AND revision = ${revision}`;
    return { state: "failed" };
  }
  const retryAt = new Date(Date.now() + RETRY_MINUTES[attempts - 1]! * 60_000);
  await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_attempts = ${attempts},
              processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId} AND revision = ${revision}`;
  return { state: "retrying", retryAt };
}

export async function registerContentJobs(boss: PgBoss) {
  await work(boss, QUEUES.analyze, { localConcurrency: 6, pollingIntervalSeconds: 2 }, ({ articleId, attemptTag }) => processArticle(articleId, { attemptTag }));
}

/**
 * Body extraction before analysis. Failures are retried a few times; after that the article is judged
 * on the excerpt it has ("unconfirmed" body, never a wrong one).
 */
export async function registerExtractionJobs(boss: PgBoss) {
  await work(boss, QUEUES.extractBody, { localConcurrency: 4, pollingIntervalSeconds: 2 }, async ({ articleId }) => {
    const [input] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId}`;
    if (!input) return { state: "missing" };
    try {
      const state = await extractArticleBody(articleId);
      // Extraction's failures do not count against the analysis that follows (a new revision starts over anyway).
      if (state !== "skipped") await sql`UPDATE articles SET processing_attempts = 0, processing_retry_at = NULL WHERE id = ${articleId} AND revision = ${input.revision}`;
      // A newer revision may still need a body after this task's result was discarded.
      await queueProcessing(articleId);
      return { state };
    } catch (error) {
      // A deploy is not the article's failure: pg-boss retries this job after the restart, as for analysis.
      if (shutdownSignal.signal.aborted) throw error;
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      const [a] = await sql<{ processing_attempts: number }[]>`
        UPDATE articles SET processing_attempts = processing_attempts + 1, processing_error = ${`extract: ${message}`},
          processing_queued_at = NULL, processing_retry_at = now() + interval '10 minutes'
        WHERE id = ${articleId} AND revision = ${input.revision} AND body_status <> 'ok' RETURNING processing_attempts`;
      if (!a) {
        await queueProcessing(articleId);
        return { state: "skipped" };
      }
      if (a.processing_attempts < MAX_EXTRACT_FAILURES) return { state: "retrying" };
      await sql`UPDATE articles SET body_status = 'unconfirmed', processing_attempts = 0, processing_retry_at = NULL
        WHERE id = ${articleId} AND revision = ${input.revision} AND body_status = 'pending'`;
      await queueProcessing(articleId);
      return { state: "unconfirmed" };
    }
  });
}

/**
 * The retry timer (content.sweep): articles waiting for processing whose retry time has come, whose
 * job was never created (a crash between write and enqueue), or whose job has waited half an hour
 * (pg-boss refuses the duplicate while it still exists). Returns the jobs actually created.
 */
export async function sweepUnprocessed(): Promise<{ enqueued: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM articles
    WHERE processing_state = 'new' AND created_at < now() - interval '3 minutes'
      AND (processing_retry_at IS NULL OR processing_retry_at <= now())
      AND (processing_queued_at IS NULL OR processing_queued_at < now() - ${QUEUED_STALE}::interval)
    ORDER BY discovered_at DESC LIMIT 500`;
  let enqueued = 0;
  for (const r of rows) if (await queueProcessing(r.id)) enqueued += 1;
  return { enqueued };
}

/**
 * The receipts of an article's analysis: an unknown outcome on any of them stops the article
 * ("failed"). Extraction never does: it retries, then judges the article on what it has.
 */
const ARTICLE_STEPS = new Set(["prefilter_article", "score_article", "structure_article", "understand_article", "summarize_article"]);

/**
 * After a receipt is released (operations/recover.ts), the article that stopped on it goes straight
 * back to processing: one action, not two. Returns whether it was queued.
 */
export async function resumeAfterRelease(receipt: { purpose: string; subject: string | null }, db: Db): Promise<boolean> {
  const article = ARTICLE_STEPS.has(receipt.purpose) ? /^article:([^@:#]+)/.exec(receipt.subject ?? "")?.[1] : undefined;
  if (!article) return false;
  const [a] = await db`UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
                        WHERE id = ${article} AND processing_state = 'failed' RETURNING id`;
  return !!a && !!(await queueProcessing(article, { step: "analyze", db }));
}

/** How the runs page groups failures: the message with ids and numbers masked. */
export const failureGroupSql = (column = "processing_error") =>
  sql.unsafe(`regexp_replace(left(coalesce(${column}, '(no message)'), 120), '[0-9a-f]{8,}|[0-9]{4,}', '…', 'g')`);

/**
 * Admin: failed articles of the last 30 days back into processing, all or one failure group. The
 * first ones are queued now; the sweep picks up the rest within minutes.
 */
export async function requeueFailed(group: string | null): Promise<{ requeued: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
    WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days'
      AND (${group}::text IS NULL OR ${failureGroupSql()} = ${group})
    RETURNING id`;
  for (const r of rows.slice(0, 500)) await queueProcessing(r.id);
  return { requeued: rows.length };
}
