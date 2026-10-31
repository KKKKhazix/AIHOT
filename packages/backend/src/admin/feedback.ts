// Feedback handling: list, status, kind and note, the pool of suggested ideas, per-source bans, and
// deletion on request (privacy notice: feedback material is removed once handling ends or when the sender asks).
import type { AdminFeedback, BeforeJson } from "@aihot/contracts/admin";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { audit, Conflict } from "../audit.ts";
import { feedbackEmailKey, resetFeedbackSubmissionState } from "../operations/feedback.ts";

export const FEEDBACK_STATUSES = ["new", "triaged", "replied", "resolved", "spam"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
/** What handling a feedback needs: fix a bug, keep a suggestion, answer a question, or nothing of these. */
export const FEEDBACK_KINDS = ["bug", "suggestion", "question", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
/** An idea's name is a short phrase, the same for every suggestion of the same thing. */
const IDEA_MAX = 40;

export async function listFeedback(f: { status?: string; kind?: string; idea?: string; q?: string; id?: number; page?: number }): Promise<BeforeJson<AdminFeedback>> {
  const page = Math.max(1, f.page ?? 1);
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const [rows, counts, kinds, ideas, bans] = await Promise.all([
    sql<Omit<BeforeJson<AdminFeedback["rows"][number]>, "email_banned">[]>`
    SELECT fb.id, fb.content, fb.email, fb.page_url, split_part(fb.screenshot_key, ':', 1) AS screenshot, fb.source_hash, fb.status, fb.kind, fb.idea, fb.note,
           fb.forwarded_at, fb.forward_error, fb.created_at, fb.updated_at,
           EXISTS (SELECT 1 FROM feedback_bans b WHERE b.source_hash = fb.source_hash AND (b.expires_at IS NULL OR b.expires_at > now())) AS banned,
           (SELECT count(*)::int FROM feedback o WHERE o.source_hash = fb.source_hash) AS from_source
    FROM feedback fb
    WHERE (${f.status ?? null}::text IS NULL OR fb.status = ${f.status ?? null})
      AND (${f.kind ?? null}::text IS NULL OR fb.kind = ${f.kind ?? null})
      AND (${f.idea ?? null}::text IS NULL OR fb.idea = ${f.idea ?? null})
      AND (${f.id ?? null}::bigint IS NULL OR fb.id = ${f.id ?? null})
      AND (${q}::text IS NULL OR fb.content ILIKE ${q} OR fb.email ILIKE ${q} OR fb.page_url ILIKE ${q})
    ORDER BY fb.created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`,
    sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM feedback GROUP BY 1`,
    sql<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM feedback WHERE kind IS NOT NULL GROUP BY 1`,
    feedbackIdeas(),
    sql<BeforeJson<AdminFeedback["bans"][number]>[]>`SELECT source_hash, reason, created_by, created_at, expires_at FROM feedback_bans
      WHERE expires_at IS NULL OR expires_at > now() ORDER BY created_at DESC LIMIT 100`,
  ]);
  // Query these separately from the capped ban list: a displayed feedback may have an older ban.
  const emailKeys = [...new Set(rows.filter(r => r.email).map(r => feedbackEmailKey(r.email!)))];
  const emailBans = new Set(emailKeys.length ? (await sql<{ source_hash: string }[]>`
    SELECT source_hash FROM feedback_bans WHERE source_hash IN ${sql(emailKeys)}
      AND (expires_at IS NULL OR expires_at > now())`).map(b => b.source_hash) : []);
  return {
    page, rows: rows.map(r => ({ ...r, email_banned: !!r.email && emailBans.has(feedbackEmailKey(r.email)) })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), kinds: Object.fromEntries(kinds.map((c) => [c.kind, c.n])), ideas, bans,
  };
}

/**
 * The whole suggestion pool, most asked first: one sender asking twice counts once (same unreadable source), spam
 * never counts. Every idea is listed, since handling names a new suggestion after the names already here.
 */
export function feedbackIdeas() {
  return sql<BeforeJson<AdminFeedback["ideas"][number]>[]>`
    SELECT idea, count(DISTINCT source_hash)::int AS people
    FROM feedback WHERE kind = 'suggestion' AND idea IS NOT NULL AND status <> 'spam'
    GROUP BY idea ORDER BY people DESC, max(created_at) DESC`;
}

/**
 * Status, kind, idea and note, against the version the admin read. Only a suggestion names an idea, so a
 * feedback reclassified as anything else leaves the pool.
 */
export async function updateFeedback(id: number, input: { status?: string; kind?: string | null; idea?: string | null; note?: string | null; version: string }, actor: string) {
  if (input.status && !FEEDBACK_STATUSES.includes(input.status as FeedbackStatus)) throw new Error(`unknown status ${input.status}`);
  if (input.kind && !FEEDBACK_KINDS.includes(input.kind as FeedbackKind)) throw new Error(`unknown kind ${input.kind}`);
  const idea = input.idea === undefined ? undefined : input.idea?.trim() || null;
  if (idea && idea.length > IDEA_MAX) throw new Error(`建议名最多 ${IDEA_MAX} 字`);
  return sql.begin(async (tx) => {
    const [before] = await tx`SELECT id, status, kind, idea, note, updated_at FROM feedback WHERE id = ${id} FOR UPDATE`;
    if (!before) return null;
    if (new Date(before.updated_at as Date).toISOString() !== input.version) throw new Conflict("这条反馈已被修改，请刷新后再操作");
    const kind = input.kind === undefined ? before.kind : input.kind;
    if (idea && kind !== "suggestion") throw new Error("只有建议能归入建议池");
    const [after] = await tx`
      UPDATE feedback SET status = coalesce(${input.status ?? null}, status), kind = ${kind},
        idea = ${kind === "suggestion" ? (idea === undefined ? before.idea : idea) : null},
        note = ${input.note === undefined ? before.note : input.note}, updated_at = now()
      WHERE id = ${id} RETURNING id, status, kind, idea, note, updated_at`;
    const record = (r: typeof after) => ({ status: r!.status, kind: r!.kind, idea: r!.idea, note: r!.note });
    await audit(actor, "feedback.update", `feedback:${id}`, null, record(before), record(after), { db: tx });
    return after;
  });
}

/** Refuses further feedback from one source (an unreadable hash of IP and browser family). */
export async function banSource(sourceHash: string, reason: string, actor: string, expiresAt: Date | null = null) {
  if (!reason.trim()) throw new Error("reason is required");
  if (expiresAt && !(expiresAt.getTime() > Date.now())) throw new Error("expiry must be in the future");
  await sql.begin(async tx => {
    await tx`INSERT INTO feedback_bans (source_hash, reason, created_by, expires_at) VALUES (${sourceHash}, ${reason}, ${actor}, ${expiresAt})
      ON CONFLICT (source_hash) DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now(), expires_at = EXCLUDED.expires_at`;
    await audit(actor, "feedback.ban", `feedback-source:${sourceHash}`, reason, null, expiresAt ? { expires_at: expiresAt.toISOString() } : null, { db: tx });
  });
}

/** Only explicit moderation of a saved report can pause an email; it is not verified identity. */
export async function banFeedbackEmail(id: number, reason: string, actor: string) {
  const [row] = await sql<{ email: string | null }[]>`SELECT email FROM feedback WHERE id=${id}`;
  if (!row?.email?.trim()) throw Object.assign(new Error("这条反馈没有可封禁的邮箱。"), { statusCode: 400 });
  const key = feedbackEmailKey(row.email);
  const expiresAt = new Date(Date.now() + 48 * 3600_000);
  await banSource(key, reason, actor, expiresAt);
  return { key, expiresAt };
}

export async function unbanSource(sourceHash: string, actor: string) {
  await sql.begin(async tx => {
    await resetFeedbackSubmissionState(sourceHash, tx);
    const rows = await tx`DELETE FROM feedback_bans WHERE source_hash = ${sourceHash} RETURNING reason`;
    if (rows.length) await audit(actor, "feedback.unban", `feedback-source:${sourceHash}`, null, { reason: rows[0]!.reason }, null, { db: tx });
  });
}

function screenshotPath(key: string | null): string | null {
  if (!key?.startsWith("local:")) return null;
  const name = key.slice("local:".length);
  return /^[\w.-]+$/.test(name) ? path.join(config.dataDir, "feedback-screenshots", name) : null;
}

export async function feedbackScreenshot(id: number): Promise<string | null> {
  const [row] = await sql<{ screenshot_key: string | null }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  return screenshotPath(row?.screenshot_key ?? null);
}

/** Removes the sender's material (text, email, page, screenshot) and keeps only the handling record. */
export async function eraseFeedback(id: number, reason: string, actor: string) {
  if (!reason.trim()) throw new Error("reason is required");
  const [row] = await sql<{ screenshot_key: string | null }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  if (!row) return null;
  const file = screenshotPath(row.screenshot_key);
  if (file) await unlink(file).catch(() => {});
  await sql`UPDATE feedback SET content = '（已按要求删除）', email = NULL, page_url = NULL, screenshot_key = NULL, updated_at = now() WHERE id = ${id}`;
  await audit(actor, "feedback.erase", `feedback:${id}`, reason, null, null);
  return { erased: true };
}
