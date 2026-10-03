// Runs view: task timeline, queue backlog, source lag, error classes, process
// heartbeats, and the receipts and deliveries whose outcome needs an operator (resolved in
// operations/recover.ts and notify/deliver.ts).
import type { AdminRuns, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import type { Heartbeat } from "../operations/heartbeat.ts";
import { audit } from "../audit.ts";
import { failureGroupSql, requeueFailed } from "../jobs/content.ts";
import { groupingOverview, waitingSelectedNews } from "../operations/grouping.ts";

const STALE_HEARTBEAT_MS = 3 * 60_000;

type Runs = BeforeJson<AdminRuns>;

export async function runsOverview(): Promise<Runs> {
  const [heartbeats, latest, timeline, queues, failedJobs, lagging, receipts, receiptIssues, deliveries, errors, ingest, leaderboard, grouping] = await Promise.all([
    sql<{ key: string; value: Heartbeat; updated_at: Date }[]>`SELECT key, value, updated_at FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY key`,
    sql<Runs["jobs"]>`
      WITH latest AS (
        SELECT DISTINCT ON (job) job, started_at, finished_at, status, left(error, 400) AS error
        FROM job_runs ORDER BY job, started_at DESC
      ), counts AS (
        SELECT job, count(*) FILTER (WHERE status = 'failed')::int AS failed_24h, count(*)::int AS runs_24h
        FROM job_runs WHERE started_at > now() - interval '24 hours' GROUP BY job
      )
      SELECT latest.*, coalesce(counts.failed_24h, 0) AS failed_24h, coalesce(counts.runs_24h, 0) AS runs_24h
      FROM latest LEFT JOIN counts USING (job) ORDER BY job`,
    sql<Runs["timeline"]>`SELECT id, job, started_at, finished_at, status, left(error, 300) AS error FROM job_runs ORDER BY started_at DESC LIMIT 80`,
    sql<Runs["queues"]>`
      SELECT name, state, count(*)::int AS n, min(created_on) AS oldest FROM pgboss.job
      WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 1, 2`,
    sql<Runs["failedJobs"]>`
      SELECT name, count(*)::int AS failed, max(completed_on) AS last, left((array_agg(output::text ORDER BY completed_on DESC))[1], 300) AS last_output
      FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`,
    sql<Runs["lagging"]>`
      SELECT id, name, kind, health, fail_count, last_ok_at, last_fetch_at, next_fetch_at, interval_minutes, left(last_error, 200) AS last_error
      FROM sources
      WHERE enabled AND kind NOT IN ('mp_account', 'external')
        AND (health = 'failing' OR next_fetch_at < now() - interval '30 minutes' OR last_ok_at < now() - make_interval(mins => greatest(interval_minutes * 6, 360)))
      ORDER BY health = 'failing' DESC, next_fetch_at LIMIT 60`,
    sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM receipts WHERE created_at > now() - interval '7 days' GROUP BY 1`,
    sql<Runs["receipts"]["issues"]>`
      SELECT id, service, model, purpose, subject, status, attempts, left(error, 240) AS error, created_at, updated_at FROM receipts
      WHERE status = 'unknown' OR (status = 'failed' AND updated_at > now() - interval '3 days') OR (status = 'pending' AND updated_at < now() - interval '15 minutes')
      ORDER BY status = 'unknown' DESC, updated_at DESC LIMIT 40`,
    sql<Runs["deliveries"]>`
      SELECT id, target_key, subject_kind, subject_id, status, attempts, left(response, 240) AS response, created_at, updated_at FROM deliveries
      WHERE status IN ('unknown', 'failed') OR (status = 'sending' AND updated_at < now() - interval '15 minutes')
      ORDER BY status = 'unknown' DESC, updated_at DESC LIMIT 40`,
    sql<Runs["errors"]>`
      SELECT ${failureGroupSql()} AS error, count(*)::int AS n, max(discovered_at) AS last,
             (array_agg(id ORDER BY discovered_at DESC))[1] AS example
      FROM articles WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    sql<Runs["ingest"]>`SELECT client, kind, status, left(error, 200) AS error, summary, created_at FROM ingest_events ORDER BY created_at DESC LIMIT 20`,
    sql<{ value: { at: string; sources: Record<string, { ok: boolean; at: string; lastOkAt: string | null; changed?: boolean; rows?: number; error?: string }> } }[]>`
      SELECT value FROM settings WHERE key = 'leaderboard.fetch'`,
    waitingSelectedNews(),
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
    grouping: groupingOverview(grouping, now),
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

/** Failed articles (one failure group, or all of the last 30 days) back into processing. */
export async function requeueFailedArticles(input: { group: string | null; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const result = await requeueFailed(input.group);
  await audit(actor, "processing.requeue", input.group ? `failure:${input.group.slice(0, 80)}` : "failure:all", input.reason, null, result);
  return result;
}
