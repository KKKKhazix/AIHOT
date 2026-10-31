// Paid requests (models, SocialData, Jina; historical Dajiala records retained) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller. ops.recover releases it once after 30 minutes (operations/recover.ts), so a lost answer
//    costs at most one repeat; after that it waits for the admin. A primary handed to a backup stays
//    unknown for billing and is not automatically released or sent again.
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
  readonly accessRefused: boolean;
  constructor(message: string, status: number | null, retryable: boolean, accessRefused = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.accessRefused = accessRefused;
  }
}

/** Model calls are switched off (MODEL_CALLS_ENABLED=false), or the model has no address or key: nothing was sent. */
export class ModelUnavailableError extends Error {}

/** A received answer that cannot be used; rejectReceivedResponse lets a later attempt pay for a fresh one. */
export class ModelOutputError extends Error {
  readonly receiptId: number | null;
  constructor(message: string, receiptId: number | null = null) {
    super(message);
    this.receiptId = receiptId;
  }
}

/**
 * What a failed paid call says about the work that made it. Each caller keeps its own policy per kind:
 * - off: model calls are switched off or the model is not configured
 * - budget: the service's budget window is full (or set to 0); nothing was sent
 * - busy: the same request is in flight elsewhere; nothing was sent
 * - outage: the provider turned the request away for now (rate limit, server error, no connection), unbilled
 * - unknown: it may have been billed and is not sent again until released (operations/recover.ts)
 * - refused: the provider refused it; the same request would be refused again
 * - unusable: an answer came back that cannot be used
 * - other: anything else (the database, a bug)
 * A worker that is stopping is the worker's state, not the error's: callers that stop on it check shutdownSignal.
 */
export type FailureKind = "off" | "budget" | "busy" | "outage" | "unknown" | "refused" | "unusable" | "other";

export function failureKind(error: unknown): FailureKind {
  if (error instanceof ModelUnavailableError) return "off";
  if (error instanceof BudgetExceededError) return "budget";
  if (error instanceof ReceiptBusyError) return "busy";
  if (error instanceof ProviderRejectedError) return error.retryable ? "outage" : "refused";
  if (error instanceof ReceiptUnknownError) return "unknown";
  if (error instanceof ModelOutputError) return "unusable";
  return "other";
}

/** The receipt a failed call leaves to look at: its unusable answer, or the request whose outcome is unknown. */
export function failedReceiptId(error: unknown): number | null {
  return error instanceof ModelOutputError || error instanceof ReceiptUnknownError ? error.receiptId : null;
}

/** The provider boundary accepts both OpenAI-compatible nested errors and flat provider errors. */
function rejectionDetail(body: string): { code: string; message: string } {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return { code: "", message: body }; }
  if (!data || typeof data !== "object") return { code: "", message: body };
  const root = data as Record<string, unknown>;
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
  return {
    code: typeof error.code === "string" || typeof error.code === "number" ? String(error.code) : typeof error.type === "string" ? error.type : "",
    message: typeof error.message === "string" ? error.message : typeof root.error === "string" ? root.error : body,
  };
}

/** Account or spending refusals, shared by live requests and their saved alert evidence. */
export function providerAccessRefused(service: string, error: string): boolean {
  const http = /(?:^| )HTTP (\d{3})(?:: ?| )([\s\S]*)$/.exec(error);
  if (!http) return false;
  const status = Number(http[1]);
  if ([401, 402, 403].includes(status)) return true;
  if (status !== 429) return false;
  const { code, message } = rejectionDetail(http[2]!);
  if (["GoUsageLimitError", "FreeUsageLimitError", "CreditLimitExceeded", "credit_balance_exhausted", "organization_usage_limit_exceeded", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"].includes(code)) return true;
  if (service === "zhipu" && ["1113", "1308", "1309", "1310", "1311", "1314", "1315", "1316", "1317", "1318", "1319", "1320", "1321"].includes(code)) return true;
  if (service === "dashscope") {
    if (["CommodityNotPurchased", "PrepaidBillOverdue", "PostpaidBillOverdue", "BudgetLimitExceeded"].includes(code)) return true;
    // AllocationQuota / insufficient_quota usually means TPM throttling here, not spent money.
    if (["Throttling.AllocationQuota", "insufficient_quota"].includes(code) && message.trim() === "Free allocated quota exceeded.") return true;
  }
  // A bare quota/limit/insufficient word is not evidence that buying capacity is required.
  return /\binsufficient (?:account |credit )?balance\b|\b(?:credit )?balance (?:is )?(?:exhausted|insufficient)\b|账户.*欠费|余额不足/i.test(message);
}

/**
 * A refusal that every later request would meet too: the account cannot pay or the plan is spent.
 * A 401/403 can be about one resource (a private post), and a 429 can be a TPM/RPM throttle, so neither
 * stops anything; the alert layer still reports them.
 */
export function providerSpendingRefused(service: string, error: string): boolean {
  const http = /(?:^| )HTTP (\d{3})(?:: ?| )([\s\S]*)$/.exec(error);
  if (!http) return false;
  const status = Number(http[1]);
  if (status === 402) return true;
  if (status !== 429) return false;
  return providerAccessRefused(service, error);
}

/** A temporary rate limit can pass; account/spending refusals need access restored first. */
export function assertAccepted(service: string, status: number, body: string): void {
  if (status >= 200 && status < 300) return;
  const { code, message } = rejectionDetail(body);
  // Keep the structured code before truncating verbose text, so saved evidence classifies the same way.
  const detail = code ? JSON.stringify({ code, message: message.slice(0, 500) }) : body.slice(0, 500);
  const error = `${service} HTTP ${status}: ${detail}`;
  const accessRefused = providerAccessRefused(service, error);
  throw new ProviderRejectedError(error, status, status >= 500 || (status === 429 && !accessRefused), accessRefused);
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
  /** A backup request continues this logical request without resending its unknown primary (marked on the primary). */
  fallbackFor?: string;
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

export async function receiptState(req: ReceiptRequest): Promise<string | null> {
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE logical_key = ${logicalKeyFor(req)}`;
  return row?.status ?? null;
}

interface ReceiptRow {
  id: number;
  status: string;
  response: unknown;
  created_at: Date;
  updated_at: Date;
}

/** How long a provider's access/billing refusal stops new calls to it. */
export const PROVIDER_STOP_SECONDS = 900;
/** The stop is a state, not a finding: the refused-provider alert (operations/alerts.ts) stays open until a
 * newer successful call, so the stop expiring never reads as a recovery. Like that alert it is per model:
 * a quota can be one model's (dashscope's free quota), and the service's other models stay callable. */
export const providerStopKey = (service: string, model?: string | null) => `provider.stop.${service}${model == null ? "" : `:${encodeURIComponent(model)}`}`;

/** Until when new calls under this stop are held, in epoch milliseconds; null when they may be sent. */
async function stopUntil(tx: Db, key: string): Promise<number | null> {
  const [row] = await tx<{ value: { until?: string } }[]>`SELECT value FROM settings WHERE key = ${key}`;
  const until = Date.parse(row?.value?.until ?? "");
  return Number.isFinite(until) && until > Date.now() ? until : null;
}

/** Record the stop an access refusal implies; refusedAt is on the database's clock, like the attempts' started_at. */
async function stopForRefusal(tx: Db, key: string): Promise<void> {
  const until = new Date(Date.now() + PROVIDER_STOP_SECONDS * 1000).toISOString();
  await tx`INSERT INTO settings (key, value, updated_by) VALUES (${key}, jsonb_build_object('until', ${until}::text, 'refusedAt', now()), 'receipts')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** An answer to a call sent after the refusal proves access is back; one already in flight may have had the last of the quota. */
async function clearStop(tx: Db, key: string, attemptId: number): Promise<void> {
  await tx`DELETE FROM settings WHERE key = ${key}
           AND coalesce((value->>'refusedAt')::timestamptz, 'epoch') < (SELECT started_at FROM receipt_attempts WHERE id = ${attemptId})`;
}

async function checkBudget(tx: Db, service: string, model?: string | null): Promise<void> {
  // A model that refused on access or billing is not called again until its stop runs out: one refused
  // request per cooldown, not one per article. Requests already in flight cannot be stopped.
  const stopped = await stopUntil(tx, providerStopKey(service, model));
  if (stopped !== null) throw new BudgetExceededError(service, "provider", Math.ceil((stopped - Date.now()) / 1000));
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
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
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>, beforeRequest?: (tx: Db) => Promise<void>): Promise<ReceiptResult> {
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
      await checkBudget(tx, req.service, req.model);
      await beforeRequest?.(tx);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req);
      return { kind: "call" as const, id: existing.id, attemptId };
    }
    await checkBudget(tx, req.service, req.model);
    await beforeRequest?.(tx);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, 1)
      RETURNING id`;
    if (req.fallbackFor) {
      await tx`UPDATE receipts SET request = request || ${tx.json({ fallbackReceiptId: row!.id })}
               WHERE logical_key = ${req.fallbackFor}`;
    }
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    return { kind: "call" as const, id: row!.id, attemptId };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true };
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(claimed.row.id, `Receipt ${claimed.row.id} has an unknown outcome; it is released once automatically, then from the admin`);
  }

  const { id: receiptId, attemptId } = claimed;
  const started = performance.now();
  let outcome: CallOutcome;
  try {
    outcome = await call();
  } catch (error) {
    // The same classification the alert layer uses, narrowed to what no later request can avoid: an
    // account/spending refusal (not a throttle or a private resource) also stops new calls to the service.
    const spendingRefused = error instanceof ProviderRejectedError && providerSpendingRefused(req.service, error.message);
    const status = error instanceof ProviderRejectedError ? "failed" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, latency_ms = ${Math.round(performance.now() - started)}, finished_at = now() WHERE id = ${attemptId}`;
      if (spendingRefused) await stopForRefusal(tx, providerStopKey(req.service, req.model));
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
        latency_ms = ${Math.round(performance.now() - started)}, finished_at = now()
      WHERE id = ${attemptId}`;
    // A real answer is the only proof that access is back; it releases a stop without waiting for it.
    await clearStop(tx, providerStopKey(req.service, req.model), attemptId);
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
 * An unknown receipt that still has to be released (by ops.recover once, then by an operator:
 * operations/recover.ts). A primary its backup continued stays unknown for billing only.
 */
export function awaitingRelease(receipt: ReturnType<typeof sql> = sql`receipts`) {
  return sql`(${receipt}.status = 'unknown' AND ${receipt}.request->>'fallbackReceiptId' IS NULL)`;
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
