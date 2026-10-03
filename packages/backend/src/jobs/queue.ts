// Job queue on PostgreSQL (pg-boss). Every queue is declared here with the data its jobs carry and its
// retry policy: business code enqueues by name, the worker registers one handler per queue (jobs/*.ts),
// and both sides are checked against JobData, so a payload cannot drift between producer and consumer.
import { PgBoss, type SendOptions, type WorkOptions } from "pg-boss";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
export { shutdownSignal } from "../lib/shutdown.ts";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export interface JobData {
  "content.analyze": { articleId: string; attemptTag?: string };
  "content.extract-body": { articleId: string };
  "events.group": { articleId: string; signalOnly?: boolean };
  "events.digest": { storyId: number };
  "sources.fetch": { sourceId: string; force?: boolean };
  "sources.fetch-x": { key: string; sourceIds: string[] };
  "sources.mp": { sourceId: string; reason?: "schedule" | "manual" };
  "notify.selected": { articleId: string; attempt?: number };
  "publication.republish-source": { sourceId: string };
  "media.prepare": { articleId: string } | { url: string; mode: string };
}
export type QueueName = keyof JobData;

export const QUEUES = {
  analyze: "content.analyze",
  extractBody: "content.extract-body",
  group: "events.group",
  digest: "events.digest",
  fetchSource: "sources.fetch",
  fetchXShard: "sources.fetch-x",
  mpCheck: "sources.mp",
  notifySelected: "notify.selected",
  republishSource: "publication.republish-source",
  prepareMedia: "media.prepare",
} as const satisfies Record<string, QueueName>;

type QueueOptions = NonNullable<Parameters<PgBoss["createQueue"]>[1]>;

/** Queue definitions in one place; created on first use by any process. */
const QUEUE_OPTIONS: Record<QueueName, QueueOptions> = {
  [QUEUES.analyze]: { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.extractBody]: { policy: "short", retryLimit: 2, retryDelay: 120, expireInSeconds: 300 },
  [QUEUES.group]: { policy: "short", retryLimit: 4, retryDelay: 20, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.digest]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.fetchSource]: { policy: "short", retryLimit: 0, expireInSeconds: 600 },
  [QUEUES.fetchXShard]: { policy: "short", retryLimit: 0, expireInSeconds: 900 },
  [QUEUES.mpCheck]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.notifySelected]: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  [QUEUES.republishSource]: { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 3600 },
  [QUEUES.prepareMedia]: { policy: "short", retryLimit: 1, retryDelay: 120, expireInSeconds: 600 },
};

const ensured = new Set<string>();

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const b = new PgBoss({ connectionString: config.databaseUrl, max: 4, schema: "pgboss", application_name: "aihot-jobs" });
    b.on("error", (err) => console.error("[pg-boss]", err));
    try {
      await b.start();
      boss = b;
      return b;
    } catch (error) {
      await b.stop({ graceful: false }).catch((cleanup) => console.error("[pg-boss] startup cleanup", cleanup));
      throw error;
    } finally {
      // A temporary connection error must not leave every caller sharing a rejected promise.
      starting = null;
    }
  })();
  return starting;
}

/** The longest single paid call (a translation batch, 180 s) plus margin; whatever stops the worker (systemd, Docker) waits longer. */
export const STOP_TIMEOUT_MS = 195_000;

export async function stopBoss(): Promise<void> {
  shutdownSignal.abort();
  if (boss) await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  boss = null;
  starting = null;
}

export async function ensureQueue(name: string, options: QueueOptions = QUEUE_OPTIONS[name as QueueName] ?? {}): Promise<void> {
  if (ensured.has(name)) return;
  const b = await getBoss();
  const existing = await b.getQueue(name);
  if (!existing) await b.createQueue(name, options);
  ensured.add(name);
}

function queueDb(tx: Db) {
  return { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) };
}

/** Enqueues a job. With `tx`, the job commits atomically with the caller's business write. */
export async function enqueue<Q extends QueueName>(name: Q, data: JobData[Q], options: SendOptions = {}, tx?: Db): Promise<string | null> {
  await ensureQueue(name);
  const b = await getBoss();
  return b.send(name, data, tx ? { ...options, db: queueDb(tx) } : options);
}

/** A receipt release also wakes jobs (e.g. grouping/embeddings) that exhausted their queue retries.
 * The release must follow the failed attempt's start: it may arrive while that attempt is finishing,
 * but cannot keep reviving attempts started after it.
 * Reading the durable audit also recovers a crash between the release and this sweep.
 */
export async function retryReleasedReceiptJobs(): Promise<number> {
  const b = await getBoss();
  return sql.begin(async (tx) => {
    const jobs = await tx<{ id: string; name: string }[]>`
      SELECT j.id, j.name FROM pgboss.job j
      WHERE j.state = 'failed'
        AND EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'receipt.release'
                    AND a.subject = 'receipt:' || (j.output->>'receiptId') AND a.created_at > j.started_on)
      ORDER BY j.completed_on LIMIT 200 FOR UPDATE OF j SKIP LOCKED`;
    for (const job of jobs) await b.retry(job.name, job.id, { db: queueDb(tx) });
    return jobs.length;
  });
}

/** The worker's handler for one queue (jobs/*.ts), called with each job's data. */
export async function work<Q extends QueueName>(boss: PgBoss, name: Q, options: WorkOptions, handler: (data: JobData[Q]) => Promise<unknown>): Promise<void> {
  await ensureQueue(name);
  await boss.work<JobData[Q]>(name, options, async ([job]) => (job ? handler(job.data) : undefined));
}

// Scheduled task bookkeeping: every run leaves a row, so operators see the latest result.

export async function recordRun<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO job_runs (job) VALUES (${job}) RETURNING id`;
  try {
    const result = await fn();
    const detail = result && typeof result === "object" ? result : { result };
    await sql`UPDATE job_runs SET status = 'ok', finished_at = now(), detail = ${sql.json(detail as never)} WHERE id = ${row!.id}`;
    return result;
  } catch (error) {
    await sql`UPDATE job_runs SET status = 'failed', finished_at = now(), error = ${String(error).slice(0, 4000)} WHERE id = ${row!.id}`;
    throw error;
  }
}
