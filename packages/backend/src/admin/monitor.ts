// Reset monitor corrections: edit an event, confirm it from a receipt review (a reader's
// or our own account showing the reset when Tibo never posted "done"), withdraw or restore it, and
// move a post between events. Public exits (page, v1 snapshot, version probe) follow updated_at.
import type { AdminMonitorEvents, AdminMonitorPosts, BeforeJson } from "@aihot/contracts/admin";
import { z } from "zod";
import { sql, type Tx } from "../db.ts";
import { awaitingReviewCondition } from "../monitor/read.ts";
import { estimateFor, manualSchedule, type Schedule } from "../monitor/time.ts";
import { audit, Conflict } from "../audit.ts";

export async function listMonitorEvents(opts: { withdrawn?: boolean } = {}): Promise<BeforeJson<AdminMonitorEvents>> {
  const events = await sql<BeforeJson<AdminMonitorEvents["events"][number]>[]>`
    SELECT e.id, e.type, e.status, e.label, e.display_label, e.scope, e.schedule, e.estimate, e.presentation, e.confirmed_at, e.occurred_on,
           e.confirmation_basis, e.withdrawn, e.created_at, e.updated_at,
           coalesce((SELECT jsonb_agg(jsonb_build_object('postId', l.post_id, 'stage', l.stage, 'action', l.action, 'text', l.text, 'originalText', l.original_text,
                                                         'publishedAt', p.published_at, 'url', p.url) ORDER BY p.published_at)
                     FROM monitor_event_posts l JOIN monitor_posts p ON p.id = l.post_id WHERE l.event_id = e.id), '[]'::jsonb) AS posts
    FROM monitor_events e
    WHERE ${opts.withdrawn ? sql`true` : sql`NOT e.withdrawn`}
    ORDER BY e.created_at DESC LIMIT 200`;
  return { events };
}

export async function listMonitorPosts(opts: { filter?: "relevant" | "review" | "pending" | "all"; page?: number }): Promise<BeforeJson<AdminMonitorPosts>> {
  const page = Math.max(1, opts.page ?? 1);
  const filter = opts.filter ?? "relevant";
  const where =
    filter === "pending" ? sql`p.processed_at IS NULL`
    : filter === "review" ? awaitingReviewCondition()
    : filter === "relevant" ? sql`(p.recognition->>'relevant')::boolean IS TRUE`
    : sql`true`;
  const rows = await sql<BeforeJson<AdminMonitorPosts["rows"][number]>[]>`
    SELECT p.id, p.published_at, p.text, p.url, p.translation, p.processed_at, p.receipt_id, p.origin,
           p.recognition->'propositions' AS propositions, (p.recognition->>'needsReview')::boolean AS needs_review,
           p.recognition->'held' AS held, (p.recognition->>'reviewed')::boolean AS reviewed, (p.recognition->>'skipped')::boolean AS skipped,
           (SELECT s.value FROM monitor_state s WHERE s.key = 'failures:' || p.id) AS failures,
           (p.recognition->>'relevant')::boolean AS relevant, p.outage,
           coalesce((SELECT jsonb_agg(jsonb_build_object('eventId', l.event_id, 'stage', l.stage)) FROM monitor_event_posts l WHERE l.post_id = p.id), '[]'::jsonb) AS links
    FROM monitor_posts p WHERE ${where}
    ORDER BY p.published_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`;
  return { page, filter, rows };
}

/**
 * Posts an admin settles by hand. "skip": the recognizer keeps failing on a post and every later one
 * waits behind it (they are recognized in order); after checking it, the post is set aside and the
 * queue moves on. "reviewed": claims held back from a post (a quote not in it, an unsure confirmation)
 * were dealt with (the event edited or confirmed, or nothing to do), so it leaves the review list.
 */
export async function resolveMonitorPost(id: string, input: { action: "skip" | "reviewed"; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  if (input.action !== "skip" && input.action !== "reviewed") throw new Error("action must be skip or reviewed");
  const [post] = await sql<{ processed_at: Date | null; recognition: Record<string, unknown> | null }[]>`SELECT processed_at, recognition FROM monitor_posts WHERE id = ${id}`;
  if (!post) return null;
  if (input.action === "skip") {
    const skipped = await sql`
      UPDATE monitor_posts SET processed_at = now(),
        recognition = ${sql.json({ skipped: true, relevant: false, needsReview: false, propositions: [], reason: input.reason, by: actor } as never)}
      WHERE id = ${id} AND processed_at IS NULL`;
    if (!skipped.count) throw new Conflict("这条帖子已经识别过了，请刷新");
    await sql`DELETE FROM monitor_state WHERE key = ${`failures:${id}`}`;
  } else {
    await sql`UPDATE monitor_posts SET recognition = coalesce(recognition, '{}'::jsonb) || ${sql.json({ reviewed: true, reviewedBy: actor, reviewReason: input.reason } as never)} WHERE id = ${id}`;
  }
  await audit(actor, `monitor.post.${input.action}`, `monitor-post:${id}`, input.reason, { processedAt: post.processed_at }, { action: input.action });
  return { id, action: input.action };
}

const Patch = z
  .object({
    type: z.enum(["direct_reset", "reset_credit"]),
    status: z.enum(["announced", "confirmed"]),
    confirmedAt: z.string().datetime({ offset: true }).nullable(),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    confirmationBasis: z.enum(["source_post", "receipt_review"]).nullable(),
    schedule: z
      .object({ precision: z.enum(["exact", "approximate", "deadline", "date", "window"]), from: z.string().datetime({ offset: true }), through: z.string().datetime({ offset: true }) })
      .nullable(),
    scope: z.string().max(200),
    scopeLabel: z.string().max(200).nullable(),
    audienceZh: z.string().max(300).nullable(),
    productsZh: z.string().max(200).nullable(),
  })
  .partial()
  .strict();

async function lockEvent(tx: Tx, id: string, version: string) {
  const [e] = await tx`SELECT * FROM monitor_events WHERE id = ${id} FOR UPDATE`;
  if (!e) return null;
  if (new Date(e.updated_at as Date).toISOString() !== version) throw new Conflict("这个事件已被修改（可能是新帖子刚到），请刷新后再改");
  return e;
}

export async function updateMonitorEvent(id: string, input: { patch: unknown; reason: string; version: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const patch = Patch.parse(input.patch);
  return sql.begin(async (tx) => {
    const before = await lockEvent(tx, id, input.version);
    if (!before) return null;
    const schedule = patch.schedule === undefined ? undefined : patch.schedule ? manualSchedule(patch.schedule.precision, new Date(patch.schedule.from), new Date(patch.schedule.through)) : null;
    const presentation: Record<string, unknown> = {};
    if (patch.scopeLabel !== undefined) Object.assign(presentation, { scopeLabel: patch.scopeLabel, scopeKnown: !!patch.scopeLabel });
    if (patch.audienceZh !== undefined) presentation.audienceZh = patch.audienceZh;
    if (patch.productsZh !== undefined) presentation.productsZh = patch.productsZh;
    if (patch.type !== undefined) presentation.kindExplicit = true;
    if (patch.status !== undefined) presentation.inProgress = false;
    const reopening = patch.status === "announced" && before.status === "confirmed";
    if (reopening) Object.assign(patch, { confirmedAt: null, occurredOn: null, confirmationBasis: null });
    const estimate = (patch.status ?? before.status) === "confirmed" ? null
      : schedule !== undefined || reopening ? estimateFor({ schedule: schedule === undefined ? before.schedule as Schedule | null : schedule, announcedAt: before.created_at as Date })
        : before.estimate;
    const [after] = await tx`
      UPDATE monitor_events SET
        type = coalesce(${patch.type ?? null}, type),
        label = CASE WHEN ${patch.type ?? null}::text IS NULL THEN label WHEN ${patch.type ?? null} = 'reset_credit' THEN '发重置卡' ELSE '全员重置' END,
        display_label = CASE WHEN ${patch.type ?? null}::text IS NULL THEN display_label WHEN ${patch.type ?? null} = 'reset_credit' THEN '重置卡发放' ELSE '额度重置' END,
        status = coalesce(${patch.status ?? null}, status),
        confirmed_at = CASE WHEN ${patch.confirmedAt !== undefined} THEN ${patch.confirmedAt ?? null}::timestamptz ELSE confirmed_at END,
        occurred_on = CASE WHEN ${patch.occurredOn !== undefined} THEN ${patch.occurredOn ?? null}::date ELSE occurred_on END,
        confirmation_basis = CASE WHEN ${patch.confirmationBasis !== undefined} THEN ${patch.confirmationBasis ?? null} ELSE confirmation_basis END,
        schedule = CASE WHEN ${schedule !== undefined} THEN ${schedule ? tx.json(schedule as never) : null}::jsonb ELSE schedule END,
        estimate = ${estimate ? tx.json(estimate as never) : null},
        scope = coalesce(${patch.scope ?? null}, scope),
        presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json(presentation as never)},
        updated_at = now()
      WHERE id = ${id} RETURNING *`;
    await audit(actor, "monitor.update", `monitor-event:${id}`, input.reason, pick(before, patch), pick(after!, patch), { db: tx });
    return after;
  });
}

function pick(row: Record<string, unknown>, patch: Record<string, unknown>) {
  const cols: Record<string, string> = { type: "type", status: "status", confirmedAt: "confirmed_at", occurredOn: "occurred_on", confirmationBasis: "confirmation_basis", schedule: "schedule", scope: "scope" };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) out[k] = cols[k] ? row[cols[k]] : (row.presentation as Record<string, unknown> | null)?.[k];
  return out;
}

/**
 * Confirms an event from an account check: the reset or the card showed up in an account, but Tibo
 * never posted "done". The Beijing day is recorded only when known; no notification goes out. A later
 * confirmation post from Tibo takes over as the source (monitor/assemble.ts); this audit entry stays.
 */
export async function reviewReceipt(id: string, input: { occurredOn?: string | null; reason: string; version: string }, actor: string) {
  const day = input.occurredOn || null;
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("occurredOn must be YYYY-MM-DD");
  // The version check below also covers this read: an account check never downgrades official evidence.
  const [event] = await sql`SELECT confirmation_basis FROM monitor_events WHERE id = ${id}`;
  const patch = { status: "confirmed", confirmationBasis: event?.confirmation_basis === "source_post" ? "source_post" : "receipt_review",
    ...(input.occurredOn !== undefined ? { occurredOn: day } : {}) };
  return updateMonitorEvent(id, { patch, reason: input.reason, version: input.version }, actor);
}

export async function setWithdrawn(id: string, input: { withdrawn: boolean; reason: string; version: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  return sql.begin(async (tx) => {
    const before = await lockEvent(tx, id, input.version);
    if (!before) return null;
    const [after] = await tx`UPDATE monitor_events SET withdrawn = ${input.withdrawn}, updated_at = now() WHERE id = ${id} RETURNING *`;
    await audit(actor, input.withdrawn ? "monitor.withdraw" : "monitor.restore", `monitor-event:${id}`, input.reason, { withdrawn: before.withdrawn }, { withdrawn: input.withdrawn }, { db: tx });
    return after;
  });
}

/** Moves (or removes) one post's link; both events' versions change. */
export async function relinkPost(input: { postId: string; fromEventId: string; toEventId: string | null; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  return sql.begin(async (tx) => {
    const [link] = await tx`SELECT * FROM monitor_event_posts WHERE event_id = ${input.fromEventId} AND post_id = ${input.postId} FOR UPDATE`;
    if (!link) throw new Conflict("这条帖子不在原事件里");
    if (input.fromEventId === input.toEventId) return { moved: false };
    if (input.toEventId) {
      const [to] = await tx`SELECT id FROM monitor_events WHERE id = ${input.toEventId}`;
      if (!to) throw new Error(`event ${input.toEventId} not found`);
      await tx`
        INSERT INTO monitor_event_posts (event_id, post_id, stage, action, text, original_text)
        VALUES (${input.toEventId}, ${input.postId}, ${link.stage}, ${link.action}, ${link.text}, ${link.original_text})
        ON CONFLICT (event_id, post_id) DO NOTHING`;
    }
    await tx`DELETE FROM monitor_event_posts WHERE event_id = ${input.fromEventId} AND post_id = ${input.postId}`;
    await tx`UPDATE monitor_posts SET activity = jsonb_set(activity, '{eventIds}',
      coalesce((SELECT jsonb_agg(event_id ORDER BY event_id) FROM monitor_event_posts WHERE post_id = ${input.postId}), '[]'::jsonb))
      WHERE id = ${input.postId} AND activity IS NOT NULL`;
    await tx`UPDATE monitor_events SET updated_at = now() WHERE id IN ${tx([input.fromEventId, input.toEventId].filter((x): x is string => !!x))}`;
    await audit(actor, "monitor.relink", `monitor-post:${input.postId}`, input.reason, { event: input.fromEventId }, { event: input.toEventId }, { db: tx });
    return { moved: true };
  });
}
