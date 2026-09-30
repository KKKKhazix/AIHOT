// Content-group deliveries (Feishu custom-bot webhooks): selected cards and reset pushes.
// One row per target and dedupe key, so nothing is pushed twice; an outcome we cannot know
// ("unknown") is never retried automatically; content older than a target's enabled_at is never
// back-filled. FEISHU_CONTENT_PUSH_ENABLED is the safety valve: off, deliveries are recorded as
// skipped and nothing leaves the process.
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { postWebhook } from "./feishu.ts";

export interface DeliveryRequest {
  subjectKind: "codex_reset" | "selected";
  subjectId: string;
  dedupeKey: string;
  /** When the underlying content appeared; older than a target's enabled_at means skip. */
  contentAt: Date;
  card: unknown;
}

interface Target {
  key: string;
  kind: "feishu_webhook" | "feishu_chat" | "log";
  enabled_at: Date | null;
  config_ref: string | null;
}

export class DeliveryConflict extends Error {
  code = "conflict";
}

/** Default content targets; they start disabled and are switched on in production only. */
export async function ensureContentTargets() {
  await sql`
    INSERT INTO notify_targets (key, purpose, kind, enabled, config_ref, note) VALUES
      ('feishu-content-main', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_WEBHOOK_URL', '飞书内容主群'),
      ('feishu-content-mirror', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_MIRROR_WEBHOOK_URL', '飞书内容镜像群')
    ON CONFLICT (key) DO NOTHING`;
}

export async function deliverContent(req: DeliveryRequest): Promise<Array<{ target: string; status: string }>> {
  const targets = await sql<Target[]>`SELECT key, kind, enabled_at, config_ref FROM notify_targets WHERE purpose = 'content' AND enabled`;
  const results: Array<{ target: string; status: string }> = [];
  for (const t of targets) {
    if (t.enabled_at && req.contentAt < t.enabled_at) continue;
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status, payload)
      VALUES (${t.key}, ${req.subjectKind}, ${req.subjectId}, ${req.dedupeKey}, 'pending', ${sql.json(req.card as never)})
      ON CONFLICT (target_key, dedupe_key) DO NOTHING RETURNING id`;
    if (!row) continue; // already delivered, skipped or in doubt
    if (!config.feishuContentPushEnabled || t.kind !== "feishu_webhook") {
      await sql`UPDATE deliveries SET status = 'skipped', response = 'content push disabled', updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "skipped" });
      continue;
    }
    const url = t.config_ref ? credential("integrations", t.config_ref) : undefined;
    if (!url) {
      await sql`UPDATE deliveries SET status = 'failed', response = 'webhook not configured', updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "failed" });
      continue;
    }
    await sql`UPDATE deliveries SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = ${row.id}`;
    try {
      const res = await postWebhook(url, req.card);
      // A Feishu error code on HTTP 200, or a 4xx, is a definite rejection; 5xx may have gone through.
      const status = res.ok ? "sent" : res.status < 500 ? "failed" : "unknown";
      await sql`UPDATE deliveries SET status = ${status}, response = ${res.body.slice(0, 500)}, sent_at = ${res.ok ? new Date() : null}, updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status });
    } catch (error) {
      // Timeout or connection loss after sending may still have delivered: never resend.
      await sql`UPDATE deliveries SET status = 'unknown', response = ${String(error).slice(0, 500)}, updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "unknown" });
    }
  }
  return results;
}

/**
 * Sends a stored delivery again after an operator checked the group and found it missing. Only
 * for deliveries in doubt or definitely failed; the safety valve still applies.
 */
export async function resendDelivery(id: number, version?: string): Promise<{ status: string }> {
  const [d] = await sql<{ status: string; version: string; payload: unknown; target_key: string; config_ref: string | null; kind: string }[]>`
    SELECT d.status, d.updated_at::text AS version, d.payload, d.target_key, t.config_ref, t.kind
    FROM deliveries d JOIN notify_targets t ON t.key = d.target_key WHERE d.id = ${id}`;
  if (!d) throw new Error(`delivery ${id} not found`);
  if (d.status !== "unknown" && d.status !== "failed") throw new DeliveryConflict("这条投递不需要处理");
  if (!config.feishuContentPushEnabled || d.kind !== "feishu_webhook") throw new Error("content push is disabled in this environment");
  const url = d.config_ref ? credential("integrations", d.config_ref) : undefined;
  if (!url) throw new Error("webhook not configured");
  // Keep PostgreSQL's timestamp precision: a retry may already have failed again by the time this
  // update runs. Only the request that claims the version the operator read may send the card.
  const claimed = await sql`UPDATE deliveries SET status = 'sending', attempts = attempts + 1, updated_at = now()
    WHERE id = ${id} AND status IN ('unknown', 'failed') AND updated_at::text = ${version ?? d.version}`;
  if (!claimed.count) throw new DeliveryConflict("这条投递已被其他操作处理，请刷新后重试");
  try {
    const res = await postWebhook(url, d.payload);
    const status = res.ok ? "sent" : res.status < 500 ? "failed" : "unknown";
    await sql`UPDATE deliveries SET status = ${status}, response = ${res.body.slice(0, 500)}, sent_at = ${res.ok ? new Date() : null}, updated_at = now() WHERE id = ${id}`;
    return { status };
  } catch (error) {
    await sql`UPDATE deliveries SET status = 'unknown', response = ${String(error).slice(0, 500)}, updated_at = now() WHERE id = ${id}`;
    return { status: "unknown" };
  }
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
