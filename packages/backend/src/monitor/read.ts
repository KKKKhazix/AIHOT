// Codex reset monitor read layer: the v1 codex-resets snapshot and the /codex-reset page read the
// same events. Announcement, in-progress, confirmation and "should have landed" stay distinct;
// passing an announced time never turns into a confirmation.
import { addDays, beijingDate, beijingMidnight } from "@aihot/contracts/time";
import type { CodexCalendarMark, CodexResetMonitor, CodexResetPageData, CodexResetsSnapshot, CodexResetVersion } from "@aihot/contracts/monitor";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { proxiedImage } from "../media/imgproxy.ts";
import { siteUrl } from "../publication/links.ts";

export const MONITOR_PAGE_URL = siteUrl("/codex-reset");
/** After the estimated window passes: "expired_unconfirmed" first, then "likely_completed". */
export const LIKELY_COMPLETED_AFTER_MS = 6 * 3600_000;
/** An acknowledged outage stays visible as a hint for this long. */
export const OUTAGE_VISIBLE_MS = 18 * 3600_000;

const OFFSET_MS = 8 * 3600_000;

/** "2026-09-26T08:07:13.000+08:00" */
export function bjIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return null;
  return `${new Date(t + OFFSET_MS).toISOString().slice(0, 23)}+08:00`;
}

interface EventRow {
  id: string;
  type: "direct_reset" | "reset_credit";
  status: "announced" | "confirmed";
  title: string;
  scope: string;
  label: string;
  display_label: string;
  schedule: { precision: string; from: string; through: string; label: string } | null;
  estimate: { from: string; through: string; basis: string; label: string; reason: string } | null;
  presentation: { scopeKnown: boolean; scopeLabel: string | null; kindExplicit: boolean; timeInferred: boolean; audienceZh: string | null; productsZh: string | null; reportedAt: string | null; inProgress?: boolean } | null;
  confirmed_at: Date | null;
  occurred_on: Date | null;
  confirmation_basis: "source_post" | "receipt_review" | null;
  created_at: Date;
  updated_at: Date;
}

interface PostRow {
  id: string;
  published_at: Date;
  text: string;
  translation: string | null;
  url: string;
  context: Array<{ id: string; author: string; relation: "reply" | "quote"; text: string | null; originalText: string; url: string }>;
  activity: { kind: "event_update" | "related"; action: string | null; statusChanged: boolean; eventIds: string[] } | null;
  outage: { kind: string; recoveredAt: string | null; resetEventId: string | null } | null;
}

interface LinkRow {
  event_id: string;
  post_id: string;
  stage: string;
  text: string;
  original_text: string;
}

export type PresentationStatus = "announced" | "in_progress" | "confirmed" | "expired_unconfirmed" | "likely_completed";

/**
 * The window decides first: an announcement whose estimated window has passed reads as late, then as
 * likely landed, even if Tibo once said it was under way; "in progress" only holds while the window is
 * still open.
 */
export function presentationStatus(e: Pick<EventRow, "status" | "estimate" | "schedule" | "presentation">, now: number): PresentationStatus {
  if (e.status === "confirmed") return "confirmed";
  const window = e.estimate ?? e.schedule;
  const through = window ? Date.parse(window.through) : null;
  if (through !== null && now >= through) return now < through + LIKELY_COMPLETED_AFTER_MS ? "expired_unconfirmed" : "likely_completed";
  return e.presentation?.inProgress ? "in_progress" : "announced";
}

/**
 * Titles follow the event's state, so an announcement that should have landed says so, and a reset
 * confirmed only by an account check does not read as Tibo's own confirmation.
 */
export function eventTitle(type: EventRow["type"], status: EventRow["status"], shown: PresentationStatus, kindExplicit: boolean, basis: EventRow["confirmation_basis"] = null): string {
  const credit = type === "reset_credit";
  if (status === "confirmed") {
    if (credit) return "重置卡已发放";
    if (basis === "receipt_review") return "额度重置已核实到账";
    return kindExplicit ? "Codex 额度重置已完成" : "Tibo 确认重置";
  }
  if (shown === "likely_completed") return credit ? "重置卡应已发放" : "额度应已重置";
  if (shown === "in_progress") return credit ? "重置卡正在发放" : "额度重置进行中";
  return credit ? "Tibo 预告将发放重置卡" : "Tibo 预告将重置额度";
}

/**
 * A post whose claims wait for a person: the recognizer was unsure, or a claim is not quoted in the post
 * (applyRecognition holds those back). It waits, however old, until an admin marks it reviewed; until
 * then the verification watermark stays put, the page shows the monitor needs attention, and the admin
 * is reminded.
 */
export function awaitingReviewCondition() {
  return sql`(recognition->>'needsReview')::boolean IS TRUE AND (recognition->>'reviewed')::boolean IS NOT TRUE`;
}

async function loadHealth(db: Db = sql) {
  const state = new Map((await db<{ key: string; value: any }[]>`
    SELECT key, value FROM monitor_state WHERE key IN ('watermarks', 'history', 'cursor')`).map((r) => [r.key, r.value]));
  const [counts] = await db<{ pending: number; review: number }[]>`
    SELECT count(*) FILTER (WHERE processed_at IS NULL) AS pending, count(*) FILTER (WHERE ${awaitingReviewCondition()}) AS review
    FROM monitor_posts`;
  return { state, counts: counts ?? { pending: 0, review: 0 } };
}

async function loadAll(now: number, from?: number) {
  // Events, links and posts must describe one committed state, including during admin corrections.
  return sql.begin("isolation level repeatable read read only", async (db) => {
    const allEvents = await db<EventRow[]>`
      SELECT id, type, status, title, scope, label, display_label, schedule, estimate, presentation, confirmed_at, occurred_on, confirmation_basis, created_at, updated_at
      FROM monitor_events WHERE NOT withdrawn ORDER BY updated_at DESC, id ASC`;
    const events = from === undefined ? allEvents : allEvents.filter((e) => e.updated_at.getTime() >= from
      || (e.presentation && ["announced", "in_progress", "expired_unconfirmed"].includes(presentationStatus(e, now))));
    const links = await db<LinkRow[]>`SELECT event_id, post_id, stage, text, original_text FROM monitor_event_posts
      WHERE ${from === undefined ? db`true` : db`event_id = ANY(${events.map((e) => e.id)}::text[])`}`;
    const posts = await db<PostRow[]>`
      SELECT id, published_at, text, translation, url, context, activity, outage FROM monitor_posts
      WHERE (activity IS NOT NULL AND ${from === undefined ? db`true` : db`published_at >= ${new Date(from)}`})
        OR (outage IS NOT NULL AND ${from === undefined ? db`true` : db`published_at >= ${new Date(now - OUTAGE_VISIBLE_MS)}`})
        OR id = ANY(${links.map((l) => l.post_id)}::text[])`;
    return { events, links, posts: new Map(posts.map((p) => [p.id, p])), ...await loadHealth(db) };
  });
}

function eventJson(e: EventRow, links: LinkRow[], posts: Map<string, PostRow>, now: number) {
  const status = presentationStatus(e, now);
  const p = e.presentation;
  const presentation = p
    ? {
        ...(p.reportedAt ? { reportedAt: bjIso(p.reportedAt) } : {}),
        status,
        scopeKnown: p.scopeKnown,
        scopeLabel: p.scopeLabel,
        kindExplicit: p.kindExplicit,
        timeInferred: p.timeInferred,
        audienceZh: p.audienceZh,
        productsZh: p.productsZh,
      }
    : null;
  const eventPosts = links
    .map((l) => ({ l, post: posts.get(l.post_id) }))
    .filter((x): x is { l: LinkRow; post: PostRow } => !!x.post)
    .sort((a, b) => b.post.published_at.getTime() - a.post.published_at.getTime() || (a.l.post_id < b.l.post_id ? 1 : -1))
    .map(({ l, post }) => ({
      id: post.id,
      publishedAt: bjIso(post.published_at),
      stage: l.stage,
      text: l.text,
      originalText: l.original_text,
      fullText: post.translation,
      fullOriginalText: post.text,
      context: contextJson(post.context),
      url: post.url,
    }));
  const schedule = e.schedule && { precision: e.schedule.precision, from: bjIso(e.schedule.from), through: bjIso(e.schedule.through), label: e.schedule.label };
  const estimate = e.estimate && { from: bjIso(e.estimate.from), through: bjIso(e.estimate.through), basis: e.estimate.basis, label: e.estimate.label, reason: e.estimate.reason };
  return {
    id: e.id,
    type: e.type,
    label: e.label,
    displayLabel: e.display_label,
    presentation,
    estimate: e.status === "confirmed" ? null : estimate,
    status: e.status,
    title: eventTitle(e.type, e.status, status, p?.kindExplicit ?? true, e.confirmation_basis),
    scope: e.scope,
    createdAt: bjIso(e.created_at),
    updatedAt: bjIso(e.updated_at),
    confirmedAt: bjIso(e.confirmed_at),
    occurredOn: e.occurred_on ? e.occurred_on.toISOString().slice(0, 10) : null,
    confirmationBasis: e.confirmation_basis,
    schedule,
    posts: eventPosts,
    url: MONITOR_PAGE_URL,
  };
}

/** Context posts in the published key order (jsonb storage does not keep it). */
function contextJson(context: PostRow["context"]) {
  return context.map((c) => ({ id: c.id, author: c.author, relation: c.relation, text: c.text, originalText: c.originalText, url: c.url }));
}


function monitorJson(state: Map<string, any>, counts: { pending: number; review: number }, now: number) {
  const w = state.get("watermarks") as { lastAttemptAt?: string; lastCollectedAt?: string; lastVerifiedAt?: string } | undefined;
  if (!w) return null;
  const verified = w.lastVerifiedAt ? Date.parse(w.lastVerifiedAt) : NaN;
  // Held windows: stretches of posts a long gap left unread, which later scans read (collectPosts).
  const held = state.get("cursor")?.backlog?.length ?? 0;
  const age = now - verified;
  // Unresolved work outranks a fresh check: a held window or a post waiting for a person needs
  // attention, a post not yet processed means the picture is delayed.
  const status: CodexResetMonitor["status"] = !Number.isFinite(verified) ? "unknown"
    : held > 0 || Number(counts.review) > 0 || age > 3 * 3600_000 ? "attention"
      : Number(counts.pending) > 0 || age > 40 * 60_000 ? "delayed" : "healthy";
  return {
    status,
    lastAttemptAt: bjIso(w.lastAttemptAt),
    lastCollectedAt: bjIso(w.lastCollectedAt),
    lastVerifiedAt: bjIso(w.lastVerifiedAt),
    heldWindowCount: held,
    pendingCount: Number(counts.pending),
    reviewCount: Number(counts.review),
  };
}

/** Days of history in the polling snapshot served at GET /api/v1/codex-resets/recent. */
export const RECENT_DAYS = 7;

/**
 * The polling form of the snapshot, same shape: events updated within the last week plus every event
 * still waiting to land, and the week's source posts. The full snapshot is about 250 KB and grows every
 * month; this one carries what a poller acts on in a few KB.
 */
export async function codexResetsRecent(now = Date.now()): Promise<CodexResetsSnapshot> {
  // Whole Beijing days, so the answer (and its ETag) only changes when the content does.
  const from = beijingMidnight(addDays(beijingDate(now), -RECENT_DAYS)).getTime();
  return snapshot(now, from);
}

/** The complete public snapshot served at GET /api/v1/codex-resets. */
export async function codexResetsSnapshot(now = Date.now()): Promise<CodexResetsSnapshot> {
  return snapshot(now);
}

async function snapshot(now: number, from?: number): Promise<CodexResetsSnapshot> {
  const { events, links, posts, state, counts } = await loadAll(now, from);
  const linksByEvent = new Map<string, LinkRow[]>();
  for (const link of links) {
    const group = linksByEvent.get(link.event_id) ?? [];
    group.push(link);
    linksByEvent.set(link.event_id, group);
  }
  const eventJsons = events.map((e) => eventJson(e, linksByEvent.get(e.id) ?? [], posts, now));
  const activities = [...posts.values()]
    .filter((p) => p.activity && (from === undefined || p.published_at.getTime() >= from))
    .sort((a, b) => b.published_at.getTime() - a.published_at.getTime())
    .map((p) => ({
      id: p.id,
      publishedAt: bjIso(p.published_at),
      eventIds: p.activity!.eventIds,
      kind: p.activity!.kind,
      text: p.translation,
      originalText: p.text,
      context: contextJson(p.context),
      statusChanged: p.activity!.statusChanged,
      action: p.activity!.action,
      url: p.url,
    }));
  const outagePost = [...posts.values()]
    .filter((p) => p.outage && now - p.published_at.getTime() <= OUTAGE_VISIBLE_MS)
    .sort((a, b) => b.published_at.getTime() - a.published_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const outage = outagePost
    ? {
        postId: outagePost.id,
        publishedAt: bjIso(outagePost.published_at),
        text: outagePost.translation,
        originalText: outagePost.text,
        recoveredAt: bjIso(outagePost.outage!.recoveredAt),
        resetEventId: outagePost.outage!.resetEventId,
        url: outagePost.url,
      }
    : null;
  const monitor = monitorJson(state, counts, now);
  return {
    schemaVersion: 1 as const,
    timezone: "Asia/Shanghai" as const,
    today: beijingDate(now),
    checkedAt: monitor?.lastVerifiedAt ?? null,
    historyFrom: bjIso(new Date(Math.max(from ?? -Infinity, Date.parse(state.get("history")?.from ?? "2026-06-12T00:00:00+08:00")))),
    count: eventJsons.length,
    events: eventJsons,
    activities,
    monitor,
    outage,
  };
}

type CalendarMark = CodexCalendarMark;

function versionHash(events: Array<[string, string | null, PresentationStatus | undefined]>, outage: string | null, monitor: CodexResetMonitor | null): string {
  const health = monitor && [monitor.status, monitor.pendingCount, monitor.reviewCount, monitor.heldWindowCount];
  return sha256(stableJson({ events, outage, health })).slice(0, 16);
}

/** Everything /codex-reset renders, derived from the same snapshot as v1. */
export async function codexResetPage(now = Date.now()): Promise<CodexResetPageData> {
  const snap = await codexResetsSnapshot(now);
  const today = snap.today;
  const marks: CalendarMark[] = snap.events.map((e) => {
    const status = e.presentation?.status ?? (e.status === "confirmed" ? "confirmed" : "announced");
    const state: CalendarMark["state"] = status === "confirmed" ? "confirmed" : status === "likely_completed" ? "likely" : "pending";
    const unclear = e.presentation ? !e.presentation.kindExplicit : false;
    const label = state === "pending" ? "待生效" : e.type === "reset_credit" ? "发重置卡" : unclear ? "重置确认" : "额度重置";
    const day = e.occurredOn ?? (e.confirmedAt ? e.confirmedAt.slice(0, 10) : (e.estimate ?? e.schedule)?.from?.slice(0, 10) ?? e.createdAt!.slice(0, 10));
    return { date: day, eventId: e.id, type: e.type, state, label };
  });
  const since = addDays(today, -90);
  const landed = marks.filter((m) => m.state !== "pending");
  const inWindow = landed.filter((m) => m.date > since && m.date <= today);
  const resetDays = [...new Set(landed.filter((m) => m.type === "direct_reset" && m.state === "confirmed" && m.date <= today).map((m) => m.date))].sort();
  // The interval is between rounds, not between calendar days: each reset at the moment it landed
  // (confirmation, verified day at noon, or the estimate's start when only likely), two resets on one
  // day are two rounds, and the median keeps one decimal.
  const landedAt = (e: (typeof snap.events)[number]) => {
    const st = e.presentation?.status ?? (e.status === "confirmed" ? "confirmed" : "announced");
    if (st === "confirmed") return Date.parse(e.occurredOn ? `${e.occurredOn}T12:00:00+08:00` : (e.confirmedAt ?? e.createdAt!));
    const from = (e.estimate ?? e.schedule)?.from;
    return st === "likely_completed" && from ? Date.parse(from) : null;
  };
  const sinceMs = now - 90 * 86400_000;
  const rounds = snap.events.filter((e) => e.type === "direct_reset").map(landedAt).filter((t): t is number => t !== null && t <= now && t >= sinceMs).sort((a, b) => a - b);
  const intervals = rounds.slice(1).map((t, i) => (t - rounds[i]!) / 86400_000).sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median = intervals.length ? Math.round((intervals.length % 2 ? intervals[mid]! : (intervals[mid - 1]! + intervals[mid]!) / 2) * 10) / 10 : null;
  const pending = snap.events.find((e) => e.presentation && ["announced", "in_progress", "expired_unconfirmed"].includes(e.presentation.status));
  // Tibo's current X avatar, from his latest collected post.
  const [author] = await sql<{ avatar: string | null }[]>`
    SELECT x_post->>'avatarUrl' AS avatar FROM articles
    WHERE source_id = 'x-account-thsottiaux' AND x_post ? 'avatarUrl' ORDER BY discovered_at DESC LIMIT 1`;
  const lastLanded = snap.events.filter((e) => landedAt(e) !== null)
    .sort((a, b) => landedAt(b)! - landedAt(a)!)[0];
  return {
    ...snap,
    current: pending ?? null,
    lastLanded: lastLanded ?? null,
    authorAvatar: author?.avatar ? proxiedImage(author.avatar, "avatar") : null,
    stats: {
      resets90: inWindow.filter((m) => m.type === "direct_reset").length,
      credits90: inWindow.filter((m) => m.type === "reset_credit").length,
      medianIntervalDays: median,
      lastResetDate: resetDays.at(-1) ?? null,
    },
    calendar: marks,
    confirmMinutes: snap.events
      .filter((e) => e.type === "direct_reset" && e.confirmedAt && e.confirmationBasis === "source_post")
      .map((e) => Number(e.confirmedAt!.slice(11, 13)) * 60 + Number(e.confirmedAt!.slice(14, 16))),
    version: versionHash(snap.events.map((e) => [e.id, e.updatedAt, e.presentation?.status]), snap.outage ? `${snap.outage.postId}${snap.outage.recoveredAt ? `:${new Date(snap.outage.recoveredAt).toISOString()}` : ""}` : null, snap.monitor),
  };
}

/** Cheap version probe for the page's foreground polling. */
export async function codexResetVersion(now = Date.now()): Promise<CodexResetVersion> {
  // Keep clock-driven transitions in the hash, without loading posts, citations, calendars or avatars.
  type VersionEvent = Pick<EventRow, "id" | "updated_at" | "status" | "estimate" | "schedule" | "presentation">;
  const [events, [outage], health] = await Promise.all([
    sql<VersionEvent[]>`SELECT id, updated_at, status, estimate, schedule, presentation
      FROM monitor_events WHERE NOT withdrawn ORDER BY updated_at DESC, id ASC`,
    sql<{ id: string }[]>`SELECT id || coalesce(':' || (outage->>'recoveredAt'), '') AS id FROM monitor_posts WHERE outage IS NOT NULL AND outage <> 'null'::jsonb
      AND published_at >= ${new Date(now - OUTAGE_VISIBLE_MS)} ORDER BY published_at DESC, id COLLATE "C" ASC LIMIT 1`,
    loadHealth(),
  ]);
  const monitor = monitorJson(health.state, health.counts, now);
  return {
    version: versionHash(events.map((e) => [e.id, bjIso(e.updated_at), e.presentation ? presentationStatus(e, now) : undefined]), outage?.id ?? null, monitor),
    checkedAt: monitor?.lastVerifiedAt ?? null,
    today: beijingDate(now),
  };
}
