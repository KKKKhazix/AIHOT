// Turns a recognized post into monitor facts: events (announce → progress → confirm, amend,
// withdraw), the post's activity role and outage links. Code decides what
// a proposition may change; the model's wording never confirms anything on its own.
import { sql, type Tx } from "../db.ts";
import { completeReceipt } from "../providers/receipts.ts";
import type { Proposition, Recognition } from "./recognize.ts";
import { estimateFor, resolveStatedTime, scheduleFrom, type Schedule } from "./time.ts";

const HOUR = 3600_000;
const OUTAGE_LINK_MS = 18 * HOUR;
/** "in about an hour", "in the next hour or so", "shortly" are approximate; "in the next few hours" is a deadline. */
const HEDGED = /\b(about|around|approximately|roughly|shortly|soon|or so)\b|~|-ish\b/i;
/** Words that introduce a further reset rather than repeat the one just mentioned. */
const ANOTHER = /\b(another|again|second|one more|twice|2nd)\b/i;
/** Tibo saying how many ("reset twice", "two resets", "3x"). Plural wording alone ("more resets coming") is one round. */
const STATED_COUNT = /\b(twice|thrice)\b|\b(two|three|four|five|[2-5])\s+(?:(?:banked|manual)\s+)?(?:times|resets?)\b|\b[2-5]\s*x\b/i;

const STAGE: Record<Proposition["kind"], Record<Proposition["action"], string>> = {
  direct_reset: { announce: "预告", progress: "进展", confirm: "确认完成", amend: "补充说明", withdraw: "撤回" },
  reset_credit: { announce: "发卡预告", progress: "进展", confirm: "确认发卡", amend: "补充说明", withdraw: "撤回" },
};

interface EventRow {
  id: string;
  type: Proposition["kind"];
  status: "announced" | "confirmed";
  schedule: Schedule | null;
  presentation: Record<string, unknown> | null;
  created_at: Date;
}

export interface Applied {
  eventIds: string[];
  /**
   * What the post tells the content groups: a new announcement or confirmation, and for an
   * announcement already out, a changed time or scope ("amend") or its withdrawal.
   */
  notify: Array<{ eventId: string; action: "announce" | "confirm" | "amend" | "withdraw"; postId: string }>;
}

/** The recognizer's words turned into a Pacific statement by code (null when nothing usable was said). */
function usableTime(p: Proposition, postAt: Date) {
  if (!p.statedTime) return null;
  const hedged = p.statedTime.precision === "approximate" && p.statedTime.relativeHours && !HEDGED.test(p.excerpt);
  return resolveStatedTime(hedged ? { ...p.statedTime, precision: "deadline" } : p.statedTime, postAt);
}

/**
 * An announcement stays open to follow-ups until 12 hours after its stated time (36 hours after it
 * was made when no time was given). Explicit follow-ups (a confirmation naming it) get two days.
 */
function isOpen(e: EventRow, postAt: Date, grace: number): boolean {
  const base = e.schedule?.through ? Date.parse(e.schedule.through) : e.created_at.getTime() + 24 * HOUR;
  return postAt.getTime() <= base + grace;
}

function legacyScope(p: Proposition): string {
  if (p.scope.plans?.length) return p.scope.plans.join("、");
  if (p.scope.audienceSource && /paid/i.test(p.scope.audienceSource)) return "所有付费订阅";
  return "";
}

function presentationOf(p: Proposition, extra: Record<string, unknown> = {}) {
  const scopeLabel = p.scope.plans?.length ? p.scope.plans.join(", ") : p.scope.audienceSource;
  return {
    scopeKnown: !!scopeLabel,
    scopeLabel: scopeLabel ?? null,
    kindExplicit: p.kindExplicit,
    timeInferred: p.timeInferred,
    audienceZh: p.scope.audienceZh,
    productsZh: p.scope.productsZh,
    reportedAt: null,
    ...extra,
  };
}

async function findTarget(tx: Tx, p: Proposition, postAt: Date): Promise<EventRow | null> {
  if (p.relatesTo) {
    const [e] = await tx<EventRow[]>`SELECT id, type, status, schedule, presentation, created_at FROM monitor_events WHERE id = ${p.relatesTo} AND NOT withdrawn`;
    // A new announcement tied to one whose time long passed is a different reset.
    if (e && e.type === p.kind && (e.status !== "announced" || isOpen(e, postAt, p.action === "announce" ? 12 * HOUR : 48 * HOUR))) return e;
  }
  if (p.action === "announce") return null;
  // Otherwise the latest announcement of the same kind that is still open; a confirmation may also
  // land on one already confirmed from an account check while Tibo had said nothing.
  const rows = await tx<EventRow[]>`
    SELECT id, type, status, schedule, presentation, created_at FROM monitor_events
    WHERE type = ${p.kind} AND NOT withdrawn AND created_at <= ${postAt}
      AND (status = 'announced' OR ${p.action === "confirm"} AND confirmation_basis = 'receipt_review' AND confirmed_at IS NULL)
    ORDER BY created_at DESC LIMIT 5`;
  return rows.find((e) => isOpen(e, postAt, 12 * HOUR)) ?? null;
}

/** Text compared loosely: case, quotes, dashes, links, emoji and spacing aside. */
function loose(text: string): string {
  return ` ${text.normalize("NFKC").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/**
 * Whether the sentence the recognizer quotes is Tibo's own words in this post: a model cannot announce
 * or confirm anything with a sentence he did not write. An elided quote ("…") matches part by part.
 */
export function quotedInPost(excerpt: string, post: string): boolean {
  const body = loose(post);
  const parts = excerpt.split(/…|\.\.\./).map(loose).filter((part) => part.trim().length > 0);
  return parts.length > 0 && parts.every((part) => body.includes(part));
}

function labelOf(p: Proposition, postAt: Date): string | null {
  const stated = usableTime(p, postAt);
  return stated ? scheduleFrom(stated).label : null;
}

async function link(tx: Tx, eventId: string, postId: string, p: Proposition) {
  await tx`
    INSERT INTO monitor_event_posts (event_id, post_id, stage, action, text, original_text)
    VALUES (${eventId}, ${postId}, ${STAGE[p.kind][p.action]}, ${p.action}, ${p.excerptZh || p.excerpt}, ${p.excerpt})
    ON CONFLICT (event_id, post_id) DO UPDATE SET stage = EXCLUDED.stage, action = EXCLUDED.action, text = EXCLUDED.text, original_text = EXCLUDED.original_text`;
}

async function createEvent(tx: Tx, p: Proposition, postId: string, index: number, postAt: Date, status: "announced" | "confirmed", extra: Record<string, unknown> = {}, nth = 1) {
  // Event ids: <kind>-<creating post>-<proposition #>-<reset # within it> ("reset twice" makes -1-1 and -1-2).
  const id = `${p.kind === "reset_credit" ? "banked" : "reset"}-${postId}-${index + 1}-${nth}`;
  const stated = usableTime(p, postAt);
  const schedule = stated ? scheduleFrom(stated) : null;
  const estimate = status === "confirmed" ? null : estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding });
  await tx`
    INSERT INTO monitor_events (id, type, status, title, scope, label, display_label, schedule, estimate, presentation, confirmed_at, confirmation_basis, created_at, updated_at)
    VALUES (${id}, ${p.kind}, ${status}, '', ${legacyScope(p)}, ${p.kind === "reset_credit" ? "发重置卡" : "全员重置"},
            ${p.kindExplicit ? (p.kind === "reset_credit" ? "重置卡发放" : "额度重置") : "重置（形式未明确）"},
            ${schedule ? tx.json(schedule as never) : null}, ${estimate ? tx.json(estimate as never) : null}, ${tx.json(presentationOf(p, extra) as never)},
            ${status === "confirmed" ? postAt : null}, ${status === "confirmed" ? "source_post" : null}, ${postAt}, ${postAt})
    ON CONFLICT (id) DO NOTHING`;
  return id;
}

/**
 * Applies one recognition inside a transaction. Idempotent for the same post: a second run (an
 * overlapping tick, a lookback, a retry) finds the post processed under its row lock and changes
 * nothing, so it cannot create a second event or notification.
 */
export async function applyRecognition(postId: string, rec: Recognition): Promise<Applied> {
  return sql.begin(async (tx) => {
    const [post] = await tx<{ published_at: Date; text: string; context: Array<Record<string, unknown>>; processed_at: Date | null }[]>`
      SELECT published_at, text, context, processed_at FROM monitor_posts WHERE id = ${postId} FOR UPDATE`;
    if (!post) throw new Error(`monitor post ${postId} not found`);
    if (post.processed_at) return { eventIds: [], notify: [] };
    const postAt = post.published_at;
    const contextZh = new Map(rec.contextZh.map((c) => [c.id, c.textZh]));
    const context = post.context.map((c) => ({ ...c, text: (c.text as string | null) ?? contextZh.get(String(c.id)) ?? null }));
    const claimed = rec.propositions.filter((p) => p.real && p.excerpt.trim());
    // An uncertain claim, including an announcement or withdrawal, cannot change public facts.
    const held = claimed.filter((p) => !quotedInPost(p.excerpt, post.text) || rec.needsReview);
    const accepted = claimed
      .filter((p) => !held.includes(p))
      // Several rounds only when Tibo states the number.
      .map((p) => (p.count > 1 && !STATED_COUNT.test(p.excerpt) ? { ...p, count: 1 } : p));
    const applied: Applied = { eventIds: [], notify: [] };
    // Events this post itself created, by kind: a later sentence repeating the same reset joins it.
    const createdHere = new Map<Proposition["kind"], { id: string; label: string | null }>();

    for (const [index, p] of accepted.entries()) {
      const here = createdHere.get(p.kind);
      if (here && !p.relatesTo && p.count === 1 && (p.action === "announce" || p.action === "progress") && !ANOTHER.test(p.excerpt)) {
        const stated = usableTime(p, postAt);
        if (!stated || scheduleFrom(stated).label === here.label) continue;
      }
      const target = await findTarget(tx, p, postAt);
      let eventId: string;
      if (p.action === "announce") {
        if (target && target.status === "announced") {
          eventId = target.id;
          const stated = usableTime(p, postAt);
          if (stated) {
            const schedule = scheduleFrom(stated);
            const estimate = estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding });
            await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${tx.json(estimate as never)}, updated_at = ${postAt} WHERE id = ${eventId}`;
            if (schedule.label !== target.schedule?.label) applied.notify.push({ eventId, action: "amend", postId });
          }
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "announced");
          createdHere.set(p.kind, { id: eventId, label: labelOf(p, postAt) });
          applied.notify.push({ eventId, action: "announce", postId });
          for (let nth = 2; nth <= p.count; nth++) {
            const extraId = await createEvent(tx, p, postId, index, postAt, "announced", {}, nth);
            await link(tx, extraId, postId, p);
            applied.eventIds.push(extraId);
          }
        }
      } else if (p.action === "progress") {
        if (target) {
          eventId = target.id;
          await tx`UPDATE monitor_events SET presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json({ inProgress: true, reportedAt: postAt.toISOString() })}, updated_at = ${postAt} WHERE id = ${eventId} AND status = 'announced'`;
          // "Propagating in the next hour" narrows when it lands.
          const stated = usableTime(p, postAt);
          if (stated && target.status === "announced") {
            const schedule = scheduleFrom(stated);
            await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${tx.json(estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding }) as never)} WHERE id = ${eventId}`;
          }
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "announced", { inProgress: true, reportedAt: postAt.toISOString() });
          createdHere.set(p.kind, { id: eventId, label: labelOf(p, postAt) });
          applied.notify.push({ eventId, action: "announce", postId });
        }
      } else if (p.action === "confirm") {
        if (target && target.status === "confirmed") {
          // A fresh confirmation long after the related event completed is a different reset.
          const [c] = await tx<{ confirmed_at: Date | null; confirmation_basis: string | null }[]>`SELECT confirmed_at, confirmation_basis FROM monitor_events WHERE id = ${target.id}`;
          if (c?.confirmed_at && postAt.getTime() - c.confirmed_at.getTime() > 6 * 3600_000) {
            eventId = await createEvent(tx, p, postId, index, postAt, "confirmed");
            applied.notify.push({ eventId, action: "confirm", postId });
            await link(tx, eventId, postId, p);
            if (!applied.eventIds.includes(eventId)) applied.eventIds.push(eventId);
            continue;
          }
          eventId = target.id;
          // Confirmed from an account check before Tibo said anything: his post now becomes the source
          // (and the earliest confirmation-post time). Status was already confirmed, so no notification.
          if (c?.confirmation_basis === "receipt_review") {
            await tx`UPDATE monitor_events SET confirmation_basis = 'source_post', confirmed_at = coalesce(confirmed_at, ${postAt}), updated_at = ${postAt} WHERE id = ${eventId}`;
          }
        } else if (target) {
          eventId = target.id;
          const updated = await tx`
            UPDATE monitor_events SET status = 'confirmed', confirmed_at = coalesce(confirmed_at, ${postAt}), confirmation_basis = coalesce(confirmation_basis, 'source_post'),
              estimate = NULL, presentation = coalesce(presentation, '{}'::jsonb) || '{"inProgress": false}'::jsonb, updated_at = ${postAt}
            WHERE id = ${eventId} AND status = 'announced'`;
          if (updated.count) applied.notify.push({ eventId, action: "confirm", postId });
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "confirmed");
          applied.notify.push({ eventId, action: "confirm", postId });
          // "We reset twice" with nothing announced: each stated round is a confirmed reset of its own.
          for (let nth = 2; nth <= p.count; nth++) {
            const extraId = await createEvent(tx, p, postId, index, postAt, "confirmed", {}, nth);
            await link(tx, extraId, postId, p);
            applied.eventIds.push(extraId);
          }
        }
      } else if (p.action === "amend") {
        if (!target) continue;
        eventId = target.id;
        const patch: Record<string, unknown> = {};
        if (p.scope.audienceSource || p.scope.plans?.length) Object.assign(patch, presentationOf(p));
        delete patch.reportedAt;
        await tx`UPDATE monitor_events SET presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json(patch as never)}, updated_at = ${postAt} WHERE id = ${eventId}`;
        const scopeChanged = "scopeLabel" in patch && patch.scopeLabel !== (target.presentation?.scopeLabel ?? null);
        let timeChanged = false;
        const stated = usableTime(p, postAt);
        if (stated && target.status === "announced") {
          const schedule = scheduleFrom(stated);
          timeChanged = schedule.label !== target.schedule?.label;
          await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${tx.json(estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding }) as never)} WHERE id = ${eventId}`;
        }
        // Readers who were told of the announcement hear of a new time or a different audience.
        if (target.status === "announced" && (timeChanged || scopeChanged)) applied.notify.push({ eventId, action: "amend", postId });
      } else {
        if (!target) continue;
        eventId = target.id;
        await tx`UPDATE monitor_events SET withdrawn = true, updated_at = ${postAt} WHERE id = ${eventId}`;
        if (target.status === "announced") applied.notify.push({ eventId, action: "withdraw", postId });
      }
      await link(tx, eventId, postId, p);
      if (!applied.eventIds.includes(eventId)) applied.eventIds.push(eventId);
    }

    const primary = accepted.find((p) => p.action !== "progress")?.action ?? null;
    const activity = applied.eventIds.length
      ? { kind: "event_update", action: primary, statusChanged: true, eventIds: applied.eventIds }
      : rec.relevant && held.length === 0
        ? { kind: "related", action: null, statusChanged: false, eventIds: rec.propositions.map((p) => p.relatesTo).filter((x): x is string => !!x) }
        : null;

    // Outage hints: an acknowledged outage, its recovery, and the reset announced after it.
    let outage: Record<string, unknown> | null = null;
    if (rec.outage === "outage") outage = { kind: "outage", recoveredAt: null, resetEventId: null };
    const [open] = await tx<{ id: string; outage: { recoveredAt: string | null; resetEventId: string | null } }[]>`
      SELECT id, outage FROM monitor_posts WHERE outage IS NOT NULL AND id <> ${postId}
        AND published_at >= ${new Date(postAt.getTime() - OUTAGE_LINK_MS)} AND published_at <= ${postAt}
      ORDER BY published_at DESC LIMIT 1`;
    if (open) {
      const patch: Record<string, unknown> = {};
      if (rec.outage === "recovery" && !open.outage.recoveredAt) patch.recoveredAt = postAt.toISOString();
      const announced = applied.notify.find((n) => n.action === "announce");
      if (announced && !open.outage.resetEventId) patch.resetEventId = announced.eventId;
      if (Object.keys(patch).length) await tx`UPDATE monitor_posts SET outage = outage || ${tx.json(patch as never)} WHERE id = ${open.id}`;
    }

    // The pushes this post owes are stored with it, in the same transaction: a push interrupted after
    // this commit is sent by the next tick (flushResetPushes), never lost.
    await tx`
      UPDATE monitor_posts SET translation = coalesce(${rec.relevant ? rec.translationZh : null}, translation), context = ${tx.json(context as never)},
        recognition = ${tx.json({ ...rec, needsReview: rec.needsReview || held.length > 0, held: held.map((p) => ({ action: p.action, excerpt: p.excerpt })), notify: applied.notify } as never)},
        activity = coalesce(${activity ? tx.json(activity as never) : null}, activity),
        outage = coalesce(${outage ? tx.json(outage as never) : null}, outage), processed_at = now()
      WHERE id = ${postId}`;
    // The paid recognition is complete once its result is committed with the post.
    await completeReceipt(tx, rec.receiptId);

    return applied;
  });
}
