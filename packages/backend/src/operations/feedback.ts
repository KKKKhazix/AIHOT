// Feedback: content, optional email, page URL, one optional screenshot. The screenshot goes to the
// internal Feishu chat and only its image key is stored (without that chat the file stays here). Abuse
// control uses an unreadable source identifier (HMAC of client IP + UA family), persistent rate
// limits, temporary bans and exact-submission retry deduplication. Confirmed email abuse can be
// paused by a moderator; unverified contact details never link automatic bans across sources.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config, credential } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";
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

/** The key of both unreadable identifiers below. */
const identifierSecret = () => credential("auth", "SESSION_SECRET") ?? "dev-feedback-secret";

export function feedbackSourceHash(ip: string, userAgent: string): string {
  const uaFamily = (userAgent.match(/(Chrome|Safari|Firefox|Edg|MicroMessenger|Mobile|Android|iPhone|iPad|Mac OS X|Windows)/g) ?? []).slice(0, 4).join("/");
  return createHmac("sha256", identifierSecret()).update(`${ip}|${uaFamily}`).digest("base64url").slice(0, 24);
}

/** An explicit moderator ban can follow a supplied email without storing it in the ban/audit log. */
export function feedbackEmailKey(email: string): string {
  return `email:${createHmac("sha256", identifierSecret()).update(email.trim().toLowerCase()).digest("base64url")}`;
}

const HOUR = 3600_000;
const MAX_SUBMISSIONS = 3;
const MAX_ATTEMPTS = 20;
type Submission = { at: number; id: number; fingerprint: string };

/** Expiry is enforced on reads; housekeeping only removes the no-longer-effective records. */
export async function expireFeedbackBans(db: Db = sql, now = new Date(), keys?: string[]) {
  const rows = await db<{ source_hash: string; reason: string | null; expires_at: Date }[]>`
    DELETE FROM feedback_bans WHERE expires_at <= ${now} ${keys ? db`AND source_hash IN ${db(keys)}` : db``}
    RETURNING source_hash, reason, expires_at`;
  for (const row of rows) await audit("feedback-auto", "feedback.unban", `feedback-source:${row.source_hash}`, "临时封禁到期", row, null, { db });
  return rows.count;
}

export async function pruneFeedbackSubmissionState(now: Date) {
  return (await sql`DELETE FROM feedback_submission_state WHERE expires_at <= ${now}`).count;
}

/** A moderator's release also clears the rate window so the next report is not immediately banned. */
export async function resetFeedbackSubmissionState(source: string, db: Db = sql) {
  await db`DELETE FROM feedback_submission_state WHERE source_hash = ${source}`;
}

/**
 * The page a report came from, as the admin opens it: a web address or a path on this site. A script or data
 * address (the form takes it from a link) is dropped and the report kept; a leading "//" or "/\" leaves the site.
 */
function pageAddress(raw: string | null | undefined): string | null {
  const page = raw?.trim().slice(0, 500);
  if (!page) return null;
  if (page.startsWith("/")) return /^\/[/\\]/.test(page) ? null : page;
  try {
    return ["http:", "https:"].includes(new URL(page).protocol) ? page : null;
  } catch {
    return null;
  }
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
  const pageUrl = pageAddress(input.pageUrl);
  const source = feedbackSourceHash(input.ip, input.userAgent);
  const network = `network:${createHmac("sha256", identifierSecret()).update(input.ip).digest("base64url")}`;
  // A ban holds under every key the source is known by.
  const keys = [source, ...serverModules().flatMap((m) => m.feedbackKeys?.(input.ip) ?? []), ...(email ? [feedbackEmailKey(email)] : [])];
  // Check before decoding an image, then again under the per-source row lock below.
  const activeBan = async (db: Db, now: Date) => {
    const [ban] = await db<{ expires_at: Date | null }[]>`SELECT expires_at FROM feedback_bans
      WHERE source_hash IN ${db(keys)} AND (expires_at IS NULL OR expires_at > ${now})
      ORDER BY expires_at DESC NULLS FIRST LIMIT 1`;
    if (!ban) return null;
    return ban.expires_at
      ? new FeedbackRejected(429, "rate_limited", "反馈提交过于频繁，已暂时暂停。请稍后再试，草稿会保留。", Math.max(1, Math.ceil((ban.expires_at.getTime() - now.getTime()) / 1000)))
      : new FeedbackRejected(403, "forbidden", "暂时无法提交反馈。");
  };
  const banned = await activeBan(sql, new Date());
  if (banned) throw banned;

  let mime: ReturnType<typeof sniffImageType> = null;
  if (input.screenshot) {
    // Some phones send JPEGs as image/jpg or with no type at all: the bytes decide.
    mime = sniffImageType(input.screenshot.data);
    if (!mime) throw new FeedbackRejected(400, "invalid_request", "截图需要是 PNG、JPG、WebP 或 GIF。");
    if (input.screenshot.data.length > 8 * 1024 * 1024) throw new FeedbackRejected(400, "invalid_request", "截图最大 8MB。");
    // The first bytes are not enough: a PNG signature followed by noise would be kept and offered to
    // Feishu again and again. Decoding the whole picture settles it (a long phone capture fits the cap).
    const decodes = await sharp(input.screenshot.data, { limitInputPixels: 60_000_000, failOn: "error" }).stats().then(() => true, () => false);
    if (!decodes) throw new FeedbackRejected(400, "invalid_request", "截图无法识别，请换一张图片。");
  }
  // Preserve code and whitespace inside reports. Changed contact, page or screenshot is a new report.
  const fingerprint = createHash("sha256").update(JSON.stringify([content, email, pageUrl,
    input.screenshot ? createHash("sha256").update(input.screenshot.data).digest("hex") : null])).digest("hex");
  let file: string | null = null;
  try {
    const result = await sql.begin(async (tx): Promise<{ id: number; fresh: boolean } | FeedbackRejected> => {
      // Concurrent retries and blue/green API processes must share the same decision and saved ID.
      // The upsert also prevents housekeeping from deleting an expired row before it is locked.
      // Lock the shared network before the browser source in every API process.
      const [networkState] = await tx<{ attempts: number[] }[]>`
        INSERT INTO feedback_submission_state (source_hash, expires_at) VALUES (${network}, ${new Date(Date.now() + HOUR)})
        ON CONFLICT (source_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at RETURNING attempts`;
      const [state] = await tx<{ attempts: number[]; submissions: Submission[] }[]>`
        INSERT INTO feedback_submission_state (source_hash, expires_at) VALUES (${source}, ${new Date(Date.now() + HOUR)})
        ON CONFLICT (source_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at RETURNING attempts, submissions`;
      const now = Date.now();
      const ban = await activeBan(tx, new Date(now));
      if (ban) return ban;
      await expireFeedbackBans(tx, new Date(now), keys);
      const attempts = state!.attempts.filter(t => t > now - HOUR);
      const submissions = state!.submissions.filter(s => s.at > now - HOUR);
      const duplicate = submissions.find(s => s.fingerprint === fingerprint);
      // A lost response or a few repeated clicks are safe retries. A continuing replay is still abuse.
      if (attempts.length >= MAX_ATTEMPTS || (!duplicate && submissions.length >= MAX_SUBMISSIONS)) {
        const until = new Date(now + HOUR);
        const reason = duplicate ? "持续重复提交反馈" : "一小时内持续提交反馈";
        await tx`INSERT INTO feedback_bans (source_hash, reason, created_by, expires_at)
          VALUES (${source}, ${reason}, 'feedback-auto', ${until})
          ON CONFLICT (source_hash) DO NOTHING`;
        await audit("feedback-auto", "feedback.ban", `feedback-source:${source}`, reason, null, { expires_at: until.toISOString() }, { db: tx });
        return new FeedbackRejected(429, "rate_limited", "反馈提交过于频繁，已暂停 1 小时。请稍后再试，草稿会保留。", 3600);
      }
      // A shared quota throttles rotating UA families without banning the whole network.
      const networkAttempts = networkState!.attempts.filter(t => t > now - HOUR);
      if (networkAttempts.length >= MAX_ATTEMPTS) {
        return new FeedbackRejected(429, "rate_limited", "同一网络反馈提交过于频繁。请稍后再试，草稿会保留。", Math.max(1, Math.ceil((networkAttempts[0]! + HOUR - now) / 1000)));
      }
      networkAttempts.push(now);
      await tx`UPDATE feedback_submission_state SET attempts = ${tx.json(networkAttempts)} WHERE source_hash = ${network}`;
      attempts.push(now);
      await tx`UPDATE feedback_submission_state SET attempts = ${tx.json(attempts)}, submissions = ${tx.json(submissions)}, expires_at = ${new Date(now + HOUR)} WHERE source_hash = ${source}`;
      if (duplicate) return { id: duplicate.id, fresh: false };
      let screenshotKey: string | null = null;
      if (input.screenshot && mime) {
        const name = `${randomUUID()}.${mime.split("/")[1]}`;
        const dir = path.join(config.dataDir, "feedback-screenshots");
        await mkdir(dir, { recursive: true });
        file = path.join(dir, name);
        await writeFile(file, input.screenshot.data);
        screenshotKey = `local:${name}`;
      }
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO feedback (content, email, page_url, screenshot_key, source_hash, forward_error)
        VALUES (${content}, ${email}, ${pageUrl}, ${screenshotKey}, ${source}, 'pending') RETURNING id`;
      const id = row!.id;
      submissions.push({ id, at: now, fingerprint });
      await tx`UPDATE feedback_submission_state SET submissions = ${tx.json(submissions)} WHERE source_hash = ${source}`;
      return { id, fresh: true };
    });
    // Rejections are thrown after commit so their counters and temporary bans survive.
    if (result instanceof FeedbackRejected) throw result;
    if (result.fresh) void forwardFeedbackToFeishu(result.id).catch(() => {});
    return { id: result.id };
  } catch (error) {
    if (file) await unlink(file).catch(() => {});
    throw error;
  }
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
