// Feedback: content, optional email, page URL, one optional screenshot. The screenshot goes to the
// internal Feishu chat and only its image key is stored (without that chat the file stays here). Abuse
// control uses an unreadable source identifier (HMAC of client IP + UA family), per-source bans and a
// per-minute limit.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { serverModules } from "../modules.ts";
import { feishuInternalEnabled, forwardFeedbackToFeishu } from "../notify/feishu.ts";

export class FeedbackRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** The picture's real type from its first bytes (what the browser claimed is not trusted). */
export function sniffImageType(data: Buffer): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  return null;
}

export function feedbackSourceHash(ip: string, userAgent: string): string {
  const secret = credential("auth", "SESSION_SECRET") ?? "dev-feedback-secret";
  const uaFamily = (userAgent.match(/(Chrome|Safari|Firefox|Edg|MicroMessenger|Mobile|Android|iPhone|iPad|Mac OS X|Windows)/g) ?? []).slice(0, 4).join("/");
  return createHmac("sha256", secret).update(`${ip}|${uaFamily}`).digest("base64url").slice(0, 24);
}

const recent = new Map<string, number[]>();
function rateLimit(source: string, perMinute = 5): void {
  const now = Date.now();
  const list = (recent.get(source) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) throw new FeedbackRejected(429, "rate_limited", "提交太频繁，请稍后再试。", 60);
  list.push(now);
  recent.set(source, list);
  if (recent.size > 5000) for (const [k, v] of recent) if (v.every((t) => now - t > 60_000)) recent.delete(k);
}

export interface FeedbackInput {
  content: string;
  email?: string | null;
  pageUrl?: string | null;
  screenshot?: { mime: string; data: Buffer } | null;
  ip: string;
  userAgent: string;
}

export async function submitFeedback(input: FeedbackInput): Promise<{ id: number }> {
  const content = input.content.trim();
  if (content.length < 2) throw new FeedbackRejected(400, "invalid_request", "请写下反馈内容。");
  if (content.length > 5000) throw new FeedbackRejected(400, "invalid_request", "反馈内容最多 5000 字。");
  const email = input.email?.trim() || null;
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new FeedbackRejected(400, "invalid_request", "邮箱格式不正确。");
  const pageUrl = input.pageUrl?.trim().slice(0, 500) || null;
  const source = feedbackSourceHash(input.ip, input.userAgent);
  // A ban holds under every key the source is known by.
  const keys = [source, ...serverModules().flatMap((m) => m.feedbackKeys?.(input.ip) ?? [])];
  const [banned] = await sql`SELECT 1 FROM feedback_bans WHERE source_hash IN ${sql(keys)}`;
  if (banned) throw new FeedbackRejected(403, "forbidden", "暂时无法提交反馈。");
  rateLimit(source);

  let screenshotKey: string | null = null;
  if (input.screenshot) {
    // Some phones send JPEGs as image/jpg or with no type at all: the bytes decide.
    const mime = sniffImageType(input.screenshot.data);
    if (!mime) throw new FeedbackRejected(400, "invalid_request", "截图需要是 PNG、JPG、WebP 或 GIF。");
    if (input.screenshot.data.length > 8 * 1024 * 1024) throw new FeedbackRejected(400, "invalid_request", "截图最大 8MB。");
    // The first bytes are not enough: a PNG signature followed by noise would be kept and offered to
    // Feishu again and again. Decoding the whole picture settles it (a long phone capture fits the cap).
    const decodes = await sharp(input.screenshot.data, { limitInputPixels: 60_000_000, failOn: "error" }).stats().then(() => true, () => false);
    if (!decodes) throw new FeedbackRejected(400, "invalid_request", "截图无法识别，请换一张图片。");
    // Stored locally until it is forwarded (notify/feishu.ts), for good where there is no internal chat;
    // the database keeps only an identifier.
    // Forwarding or erasing one feedback removes its file, even if another used the same picture.
    const name = `${randomUUID()}.${mime.split("/")[1]}`;
    const dir = path.join(config.dataDir, "feedback-screenshots");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), input.screenshot.data);
    screenshotKey = `local:${name}`;
  }
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO feedback (content, email, page_url, screenshot_key, source_hash, forward_error)
    VALUES (${content}, ${email}, ${pageUrl}, ${screenshotKey}, ${source}, 'pending') RETURNING id`;
  const id = row!.id;
  void forwardFeedbackToFeishu(id).catch(() => {});
  return { id };
}

/**
 * Whether screenshots wait here only until they reach the internal Feishu chat, which keeps them from
 * then on (the database keeps just the image key). Without the chat the file here is the screenshot
 * itself: the backups keep it and nothing expires it.
 */
export function screenshotsForwarded(): boolean {
  return feishuInternalEnabled() && credential("integrations", "FEISHU_INTERNAL_CHAT_ID") !== null;
}

/**
 * Every few minutes: feedback that did not reach the internal chat (Feishu down, a screenshot upload
 * failing) is tried again for a week. Newer than a few minutes is still being sent by its submission.
 */
export async function forwardPendingFeedback(): Promise<{ sent: number; failed: number }> {
  if (!feishuInternalEnabled()) return { sent: 0, failed: 0 };
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM feedback WHERE forwarded_at IS NULL AND forward_error IS NOT NULL
      AND created_at < now() - interval '5 minutes' AND created_at > now() - interval '7 days'
    ORDER BY id LIMIT 20`;
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      if ((await forwardFeedbackToFeishu(r.id)) === "sent") sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}
