// Runs view: task timeline, queue backlog, source lag, error classes, process
// heartbeats, and the receipts and deliveries whose outcome needs an operator.
import { sql } from "../db.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";
import { failureGroupSql, queueProcessing, requeueFailed } from "../jobs/content.ts";
import { CAPABILITIES } from "../editorial/models.ts";

const STALE_HEARTBEAT_MS = 3 * 60_000;

export async function runsOverview() {
  const [heartbeats, latest, timeline, queues, failedJobs, lagging, receipts, receiptIssues, deliveries, errors, ingest, leaderboard] = await Promise.all([
    sql<{ key: string; value: Record<string, unknown>; updated_at: Date }[]>`SELECT key, value, updated_at FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY key`,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (job) job, started_at, finished_at, status, left(error, 400) AS error
        FROM job_runs ORDER BY job, started_at DESC
      ), counts AS (
        SELECT job, count(*) FILTER (WHERE status = 'failed')::int AS failed_24h, count(*)::int AS runs_24h
        FROM job_runs WHERE started_at > now() - interval '24 hours' GROUP BY job
      )
      SELECT latest.*, coalesce(counts.failed_24h, 0) AS failed_24h, coalesce(counts.runs_24h, 0) AS runs_24h
      FROM latest LEFT JOIN counts USING (job) ORDER BY job`,
    sql`SELECT id, job, started_at, finished_at, status, left(error, 300) AS error FROM job_runs ORDER BY started_at DESC LIMIT 80`,
    sql<{ name: string; state: string; n: number; oldest: Date }[]>`
      SELECT name, state, count(*)::int AS n, min(created_on) AS oldest FROM pgboss.job
      WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 1, 2`,
    sql`
      SELECT name, count(*)::int AS failed, max(completed_on) AS last, left((array_agg(output::text ORDER BY completed_on DESC))[1], 300) AS last_output
      FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`,
    sql`
      SELECT id, name, kind, health, fail_count, last_ok_at, last_fetch_at, next_fetch_at, interval_minutes, left(last_error, 200) AS last_error
      FROM sources
      WHERE enabled AND kind NOT IN ('mp_account', 'external')
        AND (health = 'failing' OR next_fetch_at < now() - interval '30 minutes' OR last_ok_at < now() - make_interval(mins => greatest(interval_minutes * 6, 360)))
      ORDER BY health = 'failing' DESC, next_fetch_at LIMIT 60`,
    sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM receipts WHERE created_at > now() - interval '7 days' GROUP BY 1`,
    sql`
      SELECT id, service, model, purpose, subject, status, attempts, left(error, 240) AS error, created_at, updated_at FROM receipts
      WHERE status = 'unknown' OR (status = 'failed' AND updated_at > now() - interval '3 days') OR (status = 'pending' AND updated_at < now() - interval '15 minutes')
      ORDER BY status = 'unknown' DESC, updated_at DESC LIMIT 40`,
    sql`
      SELECT id, target_key, subject_kind, subject_id, status, attempts, left(response, 240) AS response, created_at, updated_at FROM deliveries
      WHERE status IN ('unknown', 'failed') OR (status = 'sending' AND updated_at < now() - interval '15 minutes')
      ORDER BY status = 'unknown' DESC, updated_at DESC LIMIT 40`,
    sql`
      SELECT ${failureGroupSql()} AS error, count(*)::int AS n, max(discovered_at) AS last,
             (array_agg(id ORDER BY discovered_at DESC))[1] AS example
      FROM articles WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    sql`SELECT client, kind, status, left(error, 200) AS error, summary, created_at FROM ingest_events ORDER BY created_at DESC LIMIT 20`,
    sql<{ value: { at: string; sources: Record<string, { ok: boolean; at: string; lastOkAt: string | null; changed?: boolean; rows?: number; error?: string }> } }[]>`
      SELECT value FROM settings WHERE key = 'leaderboard.fetch'`,
  ]);
  // Articles waiting to retry after a passing provider problem (they are not failed).
  const [retrying] = await sql<{ n: number; next: Date | null }[]>`
    SELECT count(*)::int AS n, min(processing_retry_at) AS next FROM articles WHERE processing_state = 'new' AND processing_attempts > 0`;
  const now = Date.now();
  return {
    checkedAt: new Date(now).toISOString(),
    processes: heartbeats.map((h) => ({
      role: h.key.slice("heartbeat.".length),
      ...h.value,
      at: h.updated_at,
      alive: now - h.updated_at.getTime() < STALE_HEARTBEAT_MS,
    })),
    jobs: latest,
    timeline,
    queues,
    failedJobs,
    lagging,
    receipts: { counts: Object.fromEntries(receipts.map((r) => [r.status, r.n])), issues: receiptIssues },
    deliveries,
    errors,
    retrying: { count: retrying?.n ?? 0, next: retrying?.next ?? null },
    ingest,
    leaderboard: leaderboard[0]
      ? { at: leaderboard[0].value.at, sources: Object.entries(leaderboard[0].value.sources).map(([key, v]) => ({ key, ...v })).sort((a, b) => Number(a.ok) - Number(b.ok) || a.key.localeCompare(b.key)) }
      : null,
  };
}

const ARTICLE_STEPS = new Set([
  ...(["prefilter", "score", "understand", "summarize", "structure"] as const).flatMap((step) => CAPABILITIES[step].purposes),
  "body_fallback", "x_article",
]);

/**
 * A receipt whose outcome is unknown is not re-sent by the request that lost it. Releasing it marks it
 * failed, so the next attempt calls again; an article that stopped on it goes straight back to
 * processing (one action, not two). Only an unknown receipt is released, once.
 */
async function release(id: number, error: string, actor: string, note: string, billed: boolean | null) {
  const [before] = await sql<{ subject: string | null; purpose: string }[]>`
    UPDATE receipts SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${id} AND status = 'unknown' RETURNING subject, purpose`;
  if (!before) return null;
  await sql`UPDATE receipt_attempts SET status = 'failed', error = ${error} WHERE receipt_id = ${id} AND status = 'unknown'`;
  const article = ARTICLE_STEPS.has(before.purpose) ? /^article:([^@:#]+)/.exec(before.subject ?? "")?.[1] : undefined;
  let requeued = false;
  if (article) {
    const [a] = await sql`UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
                          WHERE id = ${article} AND processing_state = 'failed' RETURNING id`;
    if (a) requeued = !!(await queueProcessing(article));
  }
  await audit(actor, "receipt.release", `receipt:${id}`, note, { status: "unknown" }, { status: "failed", billed, requeued });
  return { id, status: "failed", subject: before.subject, purpose: before.purpose, requeued };
}

/** Admin, after checking the provider's console: records whether it was billed and releases it. */
export async function releaseReceipt(id: number, input: { billed: boolean; note: string }, actor: string) {
  if (!input.note?.trim()) throw new Error("note is required");
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE id = ${id}`;
  if (!row) return null;
  if (row.status !== "unknown") throw new Conflict("只有结果未知的回执需要人工核对");
  const error = `人工核对：${input.billed ? "供应商已计费但结果未取回" : "供应商未计费"}。${input.note}`;
  return release(id, error, actor, input.note, input.billed);
}

const AUTO_RELEASE_AFTER_MS = 30 * 60_000;
const AUTO_RELEASE_NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";

/**
 * Every 10 minutes (ops.recover): unknown receipts older than half an hour are released
 * without checking the provider's bill. A lost answer costs at most one repeat: a request released this
 * way once and unknown again stays for the admin (the daily ops digest lists it).
 */
export async function autoReleaseUnknownReceipts(now = Date.now()) {
  const rows = await sql<{ id: number }[]>`
    SELECT r.id FROM receipts r
    WHERE r.status = 'unknown' AND r.updated_at < ${new Date(now - AUTO_RELEASE_AFTER_MS)}
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id = r.id AND a.error LIKE ${AUTO_RELEASE_NOTE + "%"})
    ORDER BY r.id LIMIT 200`;
  let released = 0;
  let requeued = 0;
  for (const r of rows) {
    const done = await release(r.id, AUTO_RELEASE_NOTE, "ops.recover", "结果未知，自动放行一次", null);
    if (done) released += 1;
    if (done?.requeued) requeued += 1;
  }
  return { released, requeued };
}

/** Failed articles (one failure group, or all of the last 30 days) back into processing. */
export async function requeueFailedArticles(input: { group: string | null; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const result = await requeueFailed(input.group);
  await audit(actor, "processing.requeue", input.group ? `failure:${input.group.slice(0, 80)}` : "failure:all", input.reason, null, result);
  return result;
}

/** An in-doubt delivery: confirmed as arrived, given up, or sent again after checking the group. */
export async function resolveDelivery(id: number, input: { outcome: "sent" | "drop" | "resend"; note: string }, actor: string) {
  if (!input.note?.trim()) throw new Error("note is required");
  const [before] = await sql<{ status: string; version: string }[]>`SELECT status, updated_at::text AS version FROM deliveries WHERE id = ${id}`;
  if (!before) return null;
  if (before.status !== "unknown" && before.status !== "failed") throw new Conflict("这条投递不需要处理");
  let status: string;
  if (input.outcome === "sent") {
    const changed = await sql`UPDATE deliveries SET status = 'sent', sent_at = coalesce(sent_at, now()), response = ${`人工确认已送达：${input.note}`}, updated_at = now()
      WHERE id = ${id} AND status IN ('unknown', 'failed') AND updated_at::text = ${before.version}`;
    if (!changed.count) throw new Conflict("这条投递已被其他操作处理，请刷新后重试");
    status = "sent";
  } else if (input.outcome === "drop") {
    const changed = await sql`UPDATE deliveries SET status = 'failed', response = ${`人工放弃：${input.note}`}, updated_at = now()
      WHERE id = ${id} AND status IN ('unknown', 'failed') AND updated_at::text = ${before.version}`;
    if (!changed.count) throw new Conflict("这条投递已被其他操作处理，请刷新后重试");
    status = "failed";
  } else {
    const { resendDelivery } = await import("../notify/deliver.ts");
    status = (await resendDelivery(id, before.version)).status;
  }
  await audit(actor, `delivery.${input.outcome}`, `delivery:${id}`, input.note, { status: before.status }, { status });
  return { id, status };
}
