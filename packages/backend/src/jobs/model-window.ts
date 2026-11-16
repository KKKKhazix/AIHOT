// When model calls may run (MODEL_WINDOW, Beijing, e.g. "02:00-07:00"). Collection, body extraction and
// every reader-facing read are unaffected: this only holds back the work that calls a model — article
// analysis, event grouping, event digests, the reports a model writes and the weekly rank's project
// descriptions — so a local model server is used off-peak and a machine sharing it stays quiet all day.
//
// The format is HH:MM-HH:MM over Beijing wall time, start inclusive and end exclusive. A window whose
// start is later than its end runs across midnight ("23:00-06:00"). Unset or empty means no restriction,
// which is what a deployment gets until it sets the variable, so upgrading changes nothing by itself.
import { addDays, beijingAt, beijingDate, beijingTime } from "@aihot/contracts/time";

/** Minutes since Beijing midnight; start inclusive, end exclusive. */
interface ModelWindow {
  start: number;
  end: number;
}

/** The parsed value, kept per raw string so a test or a reloaded environment is never read stale. */
let cached: { raw: string; window: ModelWindow | null } | null = null;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(value: string): number {
  const m = HHMM.exec(value.trim());
  if (!m) throw new Error(`MODEL_WINDOW must look like 02:00-07:00 (got "${value.trim()}")`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** HH:MM for minutes since midnight. */
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function parse(raw: string): ModelWindow | null {
  const value = raw.trim();
  if (!value) return null;
  const parts = value.split("-");
  if (parts.length !== 2) throw new Error(`MODEL_WINDOW must look like 02:00-07:00 (got "${value}")`);
  const start = minutesOf(parts[0]!);
  const end = minutesOf(parts[1]!);
  // A zero-length window would allow nothing at all: that is never what the variable means, so say so.
  if (start === end) throw new Error(`MODEL_WINDOW's start and end must differ (got "${value}")`);
  return { start, end };
}

/** The configured window, or null when model work is unrestricted. Throws on a malformed value. */
export function modelWindow(): ModelWindow | null {
  const raw = process.env.MODEL_WINDOW ?? "";
  if (cached?.raw !== raw) cached = { raw, window: parse(raw) };
  return cached.window;
}

const minutesNow = (now: Date) => {
  const [h, m] = beijingTime(now).split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** Whether a model call may start now. Without MODEL_WINDOW this is always true. */
export function inModelWindow(now = new Date()): boolean {
  const w = modelWindow();
  if (!w) return true;
  const t = minutesNow(now);
  return w.start < w.end ? t >= w.start && t < w.end : t >= w.start || t < w.end;
}

/** The next instant the window is open, at or after `now`. */
export function nextModelWindowStart(now = new Date()): Date {
  if (inModelWindow(now)) return now;
  const w = modelWindow()!;
  const date = beijingDate(now);
  const today = beijingAt(date, clock(w.start));
  return today.getTime() > now.getTime() ? today : beijingAt(addDays(date, 1), clock(w.start));
}

/**
 * When a job that may not run now should be queued for: null while inside the window (or with no window
 * configured), else the next opening. Callers keep the job's own identity, so a deferred job replaces
 * rather than duplicates the work.
 */
export function deferUntilModelWindow(now = new Date()): Date | null {
  return inModelWindow(now) ? null : nextModelWindowStart(now);
}

/**
 * Runs `fn` only while the window is open; outside it the run is recorded as skipped instead of calling
 * a model. The schedules that call a model use this as well as a window-shaped cron, so a window whose
 * edges fall mid-hour can never let a call slip out.
 */
export function withinModelWindow<T>(fn: () => Promise<T>): () => Promise<T | { skipped: string }> {
  return async () => (inModelWindow() ? fn() : { skipped: "outside MODEL_WINDOW" });
}

/** `0-5,23`: consecutive hours collapsed into ranges. */
function hoursField(hours: number[]): string {
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (const h of sorted.slice(1)) {
    if (h === prev + 1) {
      prev = h;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = h;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(",");
}

/**
 * A cron firing every `stepMinutes` inside the window, or null when there is no window (the caller keeps
 * its own default). Only whole hours that lie fully inside the window are listed, so the schedule itself
 * cannot fire outside it; the edge of an uneven window is covered by `withinModelWindow` instead.
 */
export function modelWindowCron(stepMinutes: number): string | null {
  const w = modelWindow();
  if (!w) return null;
  const step = Math.max(1, Math.round(stepMinutes));
  const minute = step >= 60 ? "0" : `*/${step}`;
  const firstFullHour = Math.ceil(w.start / 60);
  const lastFullHour = Math.floor(w.end / 60 - 1);
  const hours: number[] = [];
  for (let h = firstFullHour; h <= lastFullHour; h++) hours.push(h);
  if (w.start > w.end) {
    for (let h = firstFullHour; h <= 23; h++) hours.push(h);
    for (let h = 0; h <= lastFullHour; h++) hours.push(h);
  }
  // A window shorter than an hour has no whole hour of its own: fire in the hour it starts in and let
  // withinModelWindow decide. Correctness never depends on the cron being exact.
  return `${minute} ${hoursField(hours.length ? hours : [Math.floor(w.start / 60)])} * * *`;
}

/**
 * The cutoff an alert about waiting model work uses: work that started before it is late. Null means
 * nothing is late yet, which is the answer for as long as a window is open and for `graceMs` after it
 * closes — with a window, waiting is what the deployment does by design, and only work the last window
 * had a full chance at is a real problem. Without a window it is the ordinary `now - graceMs`.
 */
export function modelWaitCutoff(now: Date, graceMs: number): Date | null {
  const lw = modelWindow() ? lastModelWindow(now) : null;
  if (!lw) return new Date(now.getTime() - graceMs);
  if (now.getTime() < lw.end.getTime() + graceMs) return null;
  return lw.start;
}

/**
 * The most recent window, with its end (which may still be ahead). Alerts about waiting work read its
 * start: news collected before it and still waiting after the window ended has had its turn and is a real
 * problem, while a wait that began after it is only the window doing its job.
 */
export function lastModelWindow(now = new Date()): { start: Date; end: Date } | null {
  const w = modelWindow();
  if (!w) return null;
  const date = beijingDate(now);
  const crossing = w.start > w.end;
  const start = beijingAt(date, clock(w.start));
  if (now.getTime() >= start.getTime()) return { start, end: beijingAt(crossing ? addDays(date, 1) : date, clock(w.end)) };
  // Before today's start: the window that opened the day before, still open while it crosses midnight.
  return { start: beijingAt(addDays(date, -1), clock(w.start)), end: beijingAt(crossing ? date : addDays(date, -1), clock(w.end)) };
}
