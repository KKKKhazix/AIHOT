// Paid requests (models, SocialData, Jina; historical Dajiala records retained) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller. ops.recover releases it once after 30 minutes (operations/recover.ts), so a lost answer
//    costs at most one repeat; after that it waits for the admin.
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { shutdownSignal } from "../lib/shutdown.ts";

/** The text of a spent budget's error; with `%` for both parts it is the LIKE pattern that finds every saved one. */
export const budgetMessage = (service: string, window: string) => `Budget for ${service} exhausted (${window})`;

export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(budgetMessage(service, window));
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptBusyError extends Error {}

export class ReceiptUnknownError extends Error {
  readonly receiptId: number;
  constructor(receiptId: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.receiptId = receiptId;
  }
}

/** Raised by a call when the provider clearly did not accept (and will not bill) the request. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * The HTTP rule for every provider: an answer outside 2xx means the request was not taken. Rate limits
 * and server errors may pass; any other status is a refusal the same request would meet again.
 *
 * A refusal that names a billing limit is neither: the account is out of credit, plan or balance, so the
 * same request fails the same way until someone pays. It is reported as a spent budget — that is what the
 * pipeline already knows how to wait for — and stops calls to the service for a while, so an exhausted
 * plan costs one refused request per cooldown instead of one per article retry.
 */
const QUOTA_REFUSAL = /(quota|usage limit|usage_limit|insufficient|out of credit|balance|arrear|good standing|欠费|余额|额度)/i;
export const PROVIDER_QUOTA_COOLDOWN_SECONDS = 900;
export const quotaStopKey = (service: string) => `provider.quota.${service}`;

export function assertAccepted(service: string, status: number, body: string): void {
  if (status >= 200 && status < 300) return;
  if ((status === 402 || status === 403 || status === 429) && QUOTA_REFUSAL.test(body)) {
    throw new BudgetExceededError(service, "provider", PROVIDER_QUOTA_COOLDOWN_SECONDS);
  }
  throw new ProviderRejectedError(`${service} HTTP ${status}: ${body.slice(0, 500)}`, status, status === 429 || status >= 500);
}

/** Until when calls to this service are stopped, in epoch milliseconds; null when it may be called. */
export async function quotaStopUntil(tx: Db, service: string): Promise<number | null> {
  const [row] = await tx<{ value: { until?: string } }[]>`SELECT value FROM settings WHERE key = ${quotaStopKey(service)}`;
  const until = Date.parse(row?.value?.until ?? "");
  return Number.isFinite(until) && until > Date.now() ? until : null;
}

/** Record the cooldown a billing refusal implies, and drop the expired ones while we are here. */
async function stopForQuota(tx: Db, service: string): Promise<void> {
  const until = new Date(Date.now() + PROVIDER_QUOTA_COOLDOWN_SECONDS * 1000).toISOString();
  await tx`INSERT INTO settings (key, value, updated_by) VALUES (${quotaStopKey(service)}, ${tx.json({ until })}, 'receipts')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  await tx`DELETE FROM settings WHERE key LIKE 'provider.quota.%'
           AND coalesce((value->>'until')::timestamptz, 'epoch') < now() - interval '1 day'`;
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number; currency: string; basis: "actual" | "estimated" } | null;
}

export interface ReceiptRequest {
  service: string;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
  /** Stored for diagnosis; must not contain secrets. */
  requestSummary?: Record<string, unknown>;
  /** Distinguishes an explicit re-run (e.g. admin "re-evaluate") from recovery of the same request. */
  attemptTag?: string;
}

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
}

const PENDING_STALE_MS = 10 * 60 * 1000;

export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

interface ReceiptRow {
  id: number;
  status: string;
  response: unknown;
  created_at: Date;
  updated_at: Date;
}

async function checkBudget(tx: Db, service: string): Promise<void> {
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  // A service that said the account cannot pay is not called again until its cooldown runs out.
  const stopped = await quotaStopUntil(tx, service);
  if (stopped !== null) throw new BudgetExceededError(service, "provider", Math.ceil((stopped - Date.now()) / 1000));
  if (!budget) return; // default rows come with the migrations; a service an operator removed is unlimited
  // Every request sent counts, retries of the same logical request included.
  const [counts] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT
      count(*) FILTER (WHERE started_at > now() - interval '1 minute') AS minute,
      count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS hour,
      count(*) AS day
    FROM receipt_attempts
    WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'`;
  const c = counts!;
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  if (c.minute >= budget.per_minute) throw new BudgetExceededError(service, "minute", 60);
  if (c.hour >= budget.per_hour) throw new BudgetExceededError(service, "hour", 600);
  if (c.day >= budget.per_day) throw new BudgetExceededError(service, "day", 3600);
}

/**
 * Runs a paid request at most once per logical key and returns its raw response.
 * A caller persisting business results completes the receipt in the same transaction.
 */
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>): Promise<ReceiptResult> {
  const logicalKey = logicalKeyFor(req);

  const claimed = await sql.begin(async (tx) => {
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
    const [existing] = await tx<ReceiptRow[]>`
      SELECT id, status, response, created_at, updated_at FROM receipts WHERE logical_key = ${logicalKey} FOR UPDATE`;
    if (existing?.status === "received" || existing?.status === "completed") return { kind: "reuse" as const, row: existing };
    // Finish business writes from saved answers during shutdown, but never reserve or send the
    // next paid page/batch. An answer already in flight still saves below, without this check.
    shutdownSignal.signal.throwIfAborted();
    if (existing) {
      if (existing.status === "pending") {
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: existing };
      }
      if (existing.status === "unknown") return { kind: "unknown" as const, row: existing };
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      await checkBudget(tx, req.service);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req);
      return { kind: "call" as const, id: existing.id, attemptId };
    }
    await checkBudget(tx, req.service);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, 1)
      RETURNING id`;
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    return { kind: "call" as const, id: row!.id, attemptId };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true };
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(claimed.row.id, `Receipt ${claimed.row.id} has an unknown outcome; it is released once automatically, then from the admin`);
  }

  const { id: receiptId, attemptId } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await call();
  } catch (error) {
    // A billing refusal never ran the request, so it is a failure to record, not an unknown outcome —
    // and it stops the next calls to that service for a while.
    const quota = error instanceof BudgetExceededError;
    const status = error instanceof ProviderRejectedError || quota ? "failed" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError || quota ? error.message : String(error)).slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
      if (quota) await stopForQuota(tx, req.service);
    });
    // The first transport failure needs the same durable identity as a later unknown-result retry.
    if (status === "unknown") throw new ReceiptUnknownError(receiptId, message, { cause: error });
    throw error;
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE receipts SET
        status = 'received',
        response = ${tx.json((outcome.response ?? null) as never)},
        request_id = ${outcome.requestId ?? null},
        usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        cost = ${outcome.cost?.amount ?? null},
        currency = ${outcome.cost?.currency ?? null},
        cost_basis = ${outcome.cost?.basis ?? null},
        received_at = now(),
        updated_at = now()
      WHERE id = ${receiptId}`;
    await tx`
      UPDATE receipt_attempts SET
        status = 'received', request_id = ${outcome.requestId ?? null}, usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        cost = ${outcome.cost?.amount ?? null}, currency = ${outcome.cost?.currency ?? null}, cost_basis = ${outcome.cost?.basis ?? null},
        latency_ms = ${Date.now() - started}, finished_at = now()
      WHERE id = ${attemptId}`;
  });
  return { receiptId, response: outcome.response, reused: false };
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status) VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, 'pending')
    RETURNING id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId}`;
  await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * they are released like any other unknown outcome even when nothing retries them.
 */
export async function markStalePendingReceipts(): Promise<number> {
  const reason = "placeholder went stale without a recorded result";
  return sql.begin(async (tx) => {
    // Recheck status and age when the row lock is acquired: a response may commit while we wait.
    const stale = await tx<{ id: number }[]>`
      UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now()
      WHERE status = 'pending' AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)} RETURNING id`;
    if (stale.length) {
      await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now()
               WHERE receipt_id IN ${tx(stale.map((r) => r.id))} AND status = 'pending'`;
    }
    return stale.length;
  });
}

/**
 * Releases an unknown receipt: marked failed, so the next attempt of its request calls again (who
 * releases and when: operations/recover.ts). Null when the receipt is not, or no longer, unknown.
 */
export async function releaseUnknownReceipt(db: Db, id: number, error: string): Promise<{ subject: string | null; purpose: string } | null> {
  const [released] = await db<{ subject: string | null; purpose: string }[]>`
    UPDATE receipts SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${id} AND status = 'unknown' RETURNING subject, purpose`;
  if (released) await db`UPDATE receipt_attempts SET status = 'failed', error = ${error} WHERE receipt_id = ${id} AND status = 'unknown'`;
  return released ?? null;
}

export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${receiptId}`;
}

/** Marks a received response that could not be used (e.g. unparsable) so a fresh attempt can be made. */
export async function rejectReceivedResponse(receiptId: number, reason: string): Promise<void> {
  await sql`UPDATE receipts SET status = 'failed', error = ${reason.slice(0, 2000)}, updated_at = now() WHERE id = ${receiptId}`;
}
