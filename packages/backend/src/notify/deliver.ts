// Content-group deliveries (Feishu custom-bot webhooks), such as the cards of selected items.
// One row per target and dedupe key, so nothing is pushed twice; an outcome we cannot know
// ("unknown") is never retried automatically; content older than a target's enabled_at is never
// back-filled. FEISHU_CONTENT_PUSH_ENABLED is the safety valve: off, deliveries are recorded as
// skipped and nothing leaves the process.
import { z } from "zod";
import { audit, Conflict } from "../audit.ts";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { postWebhook } from "./feishu.ts";
import { selectedContent } from "./selected-content.ts";

export interface DeliveryRequest {
  subjectKind:
    | "selected";
  subjectId: string;
  dedupeKey: string;
  /** When the underlying content appeared; older than a target's enabled_at means skip. */
  contentAt: Date;
  card: unknown;
  /** A follow-up may only belong to one of the content groups. */
  targetKey?: string;
  /**
   * Other subjects that stand for the same news (the other reports of the fact): a target that was
   * already sent one of them, or may have been, is not sent this one.
   */
  siblings?: string[];
}

interface Target {
  key: string;
  kind: "feishu_webhook" | "feishu_chat" | "log";
  enabled_at: Date | null;
  config_ref: string | null;
}

/** Default content targets; they start disabled and are switched on in production only. */
export async function ensureContentTargets() {
  await sql`
    INSERT INTO notify_targets (key, purpose, kind, enabled, config_ref, note) VALUES
      ('feishu-content-main', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_WEBHOOK_URL', '飞书内容主群'),
      ('feishu-content-mirror', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_MIRROR_WEBHOOK_URL', '飞书内容镜像群')
    ON CONFLICT (key) DO NOTHING`;
}

/** The acknowledgement and stored outcome follow the same rules for first sends and recovery. */
async function sendDelivery(id: number, url: string, card: unknown): Promise<{ status: string }> {
  let result: Awaited<ReturnType<typeof postWebhook>>;
  try {
    result = await postWebhook(url, card);
  } catch (error) {
    // A timeout or lost connection may still have delivered. Never retry it automatically.
    result = { status: "unknown", body: String(error).slice(0, 500) };
  }
  await sql`UPDATE deliveries SET status = ${result.status}, response = ${result.body},
    sent_at = ${result.status === "sent" ? new Date() : null}, updated_at = now() WHERE id = ${id}`;
  return { status: result.status };
}

export async function deliverContent(req: DeliveryRequest): Promise<Array<{ target: string; status: string }>> {
  // A selected article may acquire a different fact after correction. Its own previous delivery
  // still counts, even when the dedupe key changes. Other kinds of push keep their own keys.
  const sentSubjects = req.subjectKind === "selected" ? [req.subjectId, ...(req.siblings ?? [])] : (req.siblings ?? []);
  const targets = await sql<{ key: string }[]>`SELECT key FROM notify_targets WHERE purpose = 'content' AND enabled
    AND (${req.targetKey ?? null}::text IS NULL OR key = ${req.targetKey ?? null}) ORDER BY key`;
  const results: Array<{ target: string; status: string }> = [];
  for (const target of targets) {
    // The preceding target can take seconds to answer. Re-read before each send so a withdrawal,
    // silence or correction reaches mirrors as well as the first group.
    const current = req.subjectKind === "selected" ? await selectedContent(req.subjectId) : null;
    if (current && current.status !== "ready") break;
    const card = current?.card ?? req.card;
    const claim = await sql.begin(async (tx) => {
      // Reserve a target in a short transaction: concurrent siblings must see each other's pending
      // delivery, even before either network request starts. No lock is held while sending.
      const [t] = await tx<Target[]>`SELECT key, kind, enabled_at, config_ref FROM notify_targets
        WHERE key = ${target.key} AND purpose = 'content' AND enabled FOR UPDATE`;
      if (!t || (t.enabled_at && req.contentAt < t.enabled_at)) return null;
      if (sentSubjects.length) {
        const [told] = await tx`SELECT 1 FROM deliveries WHERE target_key = ${t.key} AND subject_kind = ${req.subjectKind}
          AND subject_id = ANY(${sentSubjects}::text[]) AND status IN ('pending', 'sent', 'unknown', 'sending') LIMIT 1`;
        if (told) return null;
      }
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status, payload)
        VALUES (${t.key}, ${req.subjectKind}, ${req.subjectId}, ${req.dedupeKey}, 'pending', ${tx.json(card as never)})
        ON CONFLICT (target_key, dedupe_key) DO NOTHING RETURNING id`;
      return row ? { id: row.id, target: t } : null;
    });
    if (!claim) continue;
    const { id, target: t } = claim;
    if (!config.feishuContentPushEnabled || t.kind !== "feishu_webhook") {
      await sql`UPDATE deliveries SET status = 'skipped', response = 'content push disabled', updated_at = now() WHERE id = ${id}`;
      results.push({ target: t.key, status: "skipped" });
      continue;
    }
    const url = t.config_ref ? credential("integrations", t.config_ref) : undefined;
    if (!url) {
      await sql`UPDATE deliveries SET status = 'failed', response = 'webhook not configured', updated_at = now() WHERE id = ${id}`;
      results.push({ target: t.key, status: "failed" });
      continue;
    }
    await sql`UPDATE deliveries SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = ${id}`;
    results.push({ target: t.key, ...(await sendDelivery(id, url, card)) });
  }
  return results;
}

/**
 * Sends a stored delivery again after an operator checked the group and found it missing. Only
 * for deliveries in doubt or definitely failed; the safety valve still applies.
 */
export async function resendDelivery(id: number, version?: string): Promise<{ status: string }> {
  const [d] = await sql<{ status: string; version: string; payload: unknown; target_key: string; config_ref: string | null; kind: string; enabled: boolean; enabled_at: Date | null; subject_kind: string; subject_id: string }[]>`
    SELECT d.status, d.updated_at::text AS version, d.payload, d.target_key, t.config_ref, t.kind, t.enabled, t.enabled_at, d.subject_kind, d.subject_id
    FROM deliveries d JOIN notify_targets t ON t.key = d.target_key WHERE d.id = ${id}`;
  if (!d) throw new Error(`delivery ${id} not found`);
  if (d.status !== "unknown" && d.status !== "failed") throw new Conflict("这条投递不需要处理");
  if (!config.feishuContentPushEnabled || d.kind !== "feishu_webhook") throw new Error("content push is disabled in this environment");
  if (!d.enabled) throw new Conflict("这个推送群已停用");
  const current = d.subject_kind === "selected" ? await selectedContent(d.subject_id) : null;
  if (current && (current.status !== "ready" || (d.enabled_at && current.article.discovered_at < d.enabled_at))) {
    throw new Conflict("这条内容已不再符合推送条件");
  }
  const payload = current?.card ?? d.payload;
  const url = d.config_ref ? credential("integrations", d.config_ref) : undefined;
  if (!url) throw new Error("webhook not configured");
  // Keep PostgreSQL's timestamp precision: a retry may already have failed again by the time this
  // update runs. Only the request that claims the version the operator read may send the card.
  const claimed = await sql`UPDATE deliveries SET status = 'sending', attempts = attempts + 1, payload = ${sql.json(payload as never)}, updated_at = now()
    WHERE id = ${id} AND status IN ('unknown', 'failed') AND updated_at::text = ${version ?? d.version}`;
  if (!claimed.count) throw new Conflict("这条投递已被其他操作处理，请刷新后重试");
  return sendDelivery(id, url, payload);
}

/**
 * Deliveries a stopped process left half way: "sending" may have reached the group, so it becomes
 * "unknown" (alerted, resolved in the admin); "pending" never left, so it becomes "failed" (the
 * admin can send it). Nothing is re-sent automatically.
 */
export async function markStaleDeliveries(): Promise<{ unknown: number; failed: number }> {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const unknown = await sql`UPDATE deliveries SET status = 'unknown', response = coalesce(response, '发送中进程中断，是否送达未知'), updated_at = now()
                            WHERE status = 'sending' AND updated_at < ${cutoff}`;
  const failed = await sql`UPDATE deliveries SET status = 'failed', response = coalesce(response, '发送前进程中断，没有发出'), updated_at = now()
                           WHERE status = 'pending' AND updated_at < ${cutoff}`;
  return { unknown: unknown.count, failed: failed.count };
}

/** An in-doubt delivery: confirmed as arrived, given up, or sent again after checking the group. */
export async function resolveDelivery(id: number, input: { outcome: "sent" | "drop" | "resend"; note: string }, actor: string) {
  input = z.object({ outcome: z.enum(["sent", "drop", "resend"]), note: z.string().trim().min(1) }).parse(input);
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
    status = (await resendDelivery(id, before.version)).status;
  }
  await audit(actor, `delivery.${input.outcome}`, `delivery:${id}`, input.note, { status: before.status }, { status });
  return { id, status };
}
