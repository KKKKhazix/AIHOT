// Time windows for reset announcements. Tibo speaks in Pacific time ("6pm PST" means Pacific local
// time, daylight saving included); the site shows Beijing time. The schedule restates his words; the
// estimate is AIHOT's landing window and is always labelled as such.

const PACIFIC = "America/Los_Angeles";
const HOUR = 3600_000;

/** UTC instant of a Pacific wall-clock time ("2026-09-25", "18:00"). */
export function pacificToUtc(date: string, time: string): Date {
  if (time === "24:00") {
    // "end of day": midnight at the end of that Pacific date
    const next = new Date(Date.UTC(...(date.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number]) + 36 * HOUR);
    return pacificToUtc(next.toISOString().slice(0, 10), "00:00");
  }
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h + 8, mi); // PST
  for (const offset of [8, 7]) {
    const t = Date.UTC(y, mo - 1, d, h + offset, mi);
    if (pacificParts(new Date(t)).hm === `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` && pacificParts(new Date(t)).date === date) return new Date(t);
  }
  return new Date(guess);
}

export function pacificParts(d: Date): { date: string; hm: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hm: `${get("hour")}:${get("minute")}`, hour: Number(get("hour")) };
}

const bj = (d: Date) => new Date(d.getTime() + 8 * HOUR);
const md = (d: Date) => `${bj(d).getUTCMonth() + 1}月${bj(d).getUTCDate()}日`;
const hm = (d: Date) => bj(d).toISOString().slice(11, 16);

/** "9月8日 09:00–10:00" or "9月22日 15:00–9月23日 15:00" in Beijing time. */
export function beijingRange(from: Date, through: Date): string {
  if (from.getTime() === through.getTime()) return `${md(from)} ${hm(from)}`;
  const sameDay = bj(from).toISOString().slice(0, 10) === bj(through).toISOString().slice(0, 10);
  return sameDay ? `${md(from)} ${hm(from)}–${hm(through)}` : `${md(from)} ${hm(from)}–${md(through)} ${hm(through)}`;
}

export type SchedulePrecision = "exact" | "approximate" | "deadline" | "date" | "window";

/** What Tibo said about time, as the recognition model read it (Pacific wall clock). */
export interface StatedTime {
  precision: SchedulePrecision;
  /** Pacific date the statement refers to. */
  date: string;
  /** Pacific time for exact/approximate/deadline; window start. Null for date-only. */
  from: string | null;
  /** Window end (Pacific), when he gave a range. */
  through: string | null;
}

export interface Schedule {
  precision: SchedulePrecision;
  from: string;
  through: string;
  label: string;
}

/** Converts Tibo's own words into Beijing time. Kept after completion; never an execution receipt. */
export function scheduleFrom(stated: StatedTime): Schedule {
  if (stated.precision === "date") {
    // A whole Pacific day.
    const from = pacificToUtc(stated.date, "00:00");
    const through = new Date(pacificToUtc(stated.date, "23:59").getTime() + 60_000);
    return { precision: "date", from: from.toISOString(), through: through.toISOString(), label: `北京时间预计 ${beijingRange(from, through)}` };
  }
  const start = pacificToUtc(stated.date, stated.from ?? "18:00");
  if (stated.precision === "deadline") {
    return { precision: "deadline", from: start.toISOString(), through: start.toISOString(), label: `北京时间预计 ${md(start)} ${hm(start)} 前` };
  }
  if (stated.precision === "approximate") {
    return { precision: "approximate", from: start.toISOString(), through: start.toISOString(), label: `北京时间约 ${md(start)} ${hm(start)}` };
  }
  // exact / window: a stated clock time lands within the hour.
  const end = stated.through ? pacificToUtc(stated.through < (stated.from ?? "18:00") ? addPacificDays(stated.date, 1) : stated.date, stated.through) : new Date(start.getTime() + HOUR);
  return { precision: stated.precision === "exact" ? "window" : stated.precision, from: start.toISOString(), through: end.toISOString(), label: `北京时间预计 ${beijingRange(start, end)}` };
}

export type EstimateBasis = "model" | "source" | "source_day" | "history";

export interface Estimate {
  from: string;
  through: string;
  basis: EstimateBasis;
  label: string;
  reason: string;
}

/** Tibo usually presses the button 16:30–21:30 Pacific (07:30–12:30 Beijing the next morning). */
const USUAL_FROM = "16:30";
const USUAL_TO = "21:30";

function estimate(from: Date, through: Date, basis: EstimateBasis, reason: string): Estimate {
  return { from: from.toISOString(), through: through.toISOString(), basis, label: `北京时间 ${beijingRange(from, through)}`, reason };
}

/**
 * AIHOT's landing window for an unconfirmed announcement. A model window is accepted only when it
 * is well-formed and does not contradict the stated time; otherwise the stated time (plus a
 * one-to-two-hour allowance) or his usual timing is used.
 */
export function estimateFor(opts: { schedule: Schedule | null; announcedAt: Date; model?: { earliestPacific: string; latestPacific: string; note: string } | null }): Estimate {
  const { schedule, announcedAt, model } = opts;
  if (model) {
    const parse = (s: string) => {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(s.trim());
      return m ? pacificToUtc(m[1]!, m[2]!) : null;
    };
    const a = parse(model.earliestPacific);
    const b = parse(model.latestPacific);
    const sane = a && b && b > a && b.getTime() - a.getTime() <= 36 * HOUR && a >= announcedAt;
    const consistent = !schedule || (a && b && b >= new Date(schedule.from) && a <= new Date(new Date(schedule.through).getTime() + 12 * HOUR)
      && (schedule.precision === "deadline" || a >= new Date(schedule.from)));
    if (sane && consistent) return estimate(a!, b!, "model", `模型推算：${model.note}`);
  }
  if (schedule && schedule.precision === "date") {
    const day = pacificParts(new Date(schedule.from)).date;
    return estimate(pacificToUtc(day, USUAL_FROM), pacificToUtc(day, USUAL_TO), "source_day", "Tibo 只给了日期，按他以往的习惯落在当天太平洋时间傍晚。");
  }
  if (schedule && schedule.precision === "deadline") {
    // "Within the hour", "by 8pm": any time from the announcement (at most a day ahead) until a little
    // after the deadline, not a window that only starts at the deadline (legacy estimate).
    const deadline = new Date(schedule.through).getTime();
    const from = Math.min(Math.max(announcedAt.getTime(), deadline - 24 * HOUR), deadline);
    return estimate(new Date(from), new Date(deadline + HOUR), "source", "按原帖给出的截止时间换算成北京时间，并预留一点延迟。");
  }
  if (schedule) {
    // Around a time: from half an hour before it (not before the post); otherwise from the stated start.
    const start = new Date(schedule.from).getTime();
    const from = schedule.precision === "approximate" ? Math.max(announcedAt.getTime(), start - HOUR / 2) : start;
    const through = new Date(new Date(schedule.through).getTime() + 2 * HOUR);
    return estimate(new Date(from), through, "source", "按原帖时间换算成北京时间，并预留一两个小时：他的确认帖通常比说的时间晚一点。");
  }
  // No time given: the next usual evening after the announcement.
  const p = pacificParts(announcedAt);
  let day = p.date;
  if (p.hm > USUAL_TO) {
    const next = new Date(pacificToUtc(day, "12:00").getTime() + 24 * HOUR);
    day = pacificParts(next).date;
  }
  const from = pacificToUtc(day, USUAL_FROM);
  return estimate(from < announcedAt ? announcedAt : from, pacificToUtc(day, USUAL_TO), "history", "原帖没有给出时间，按 Tibo 以往按下重置的时段推算。");
}

/** What the recognizer extracted: relative hours, a named period, a clock time and/or a day offset. */
export interface StatedWords {
  precision: SchedulePrecision;
  relativeHours: number | null;
  period: "afternoon" | "evening" | "tonight" | "end_of_day" | null;
  clock: string | null;
  clockThrough: string | null;
  dayOffset: number | null;
}

const addPacificDays = (date: string, days: number) => pacificParts(new Date(pacificToUtc(date, "12:00").getTime() + days * 24 * HOUR)).date;
const hhmm = (d: Date) => pacificParts(d).hm;

/** Turns the recognizer's words into a Pacific wall-clock statement, doing the arithmetic in code. */
export function resolveStatedTime(w: StatedWords, postAt: Date): StatedTime | null {
  const post = pacificParts(postAt);
  const day = w.dayOffset ? addPacificDays(post.date, w.dayOffset) : post.date;
  if (w.relativeHours !== null && w.relativeHours > 0) {
    const at = new Date(postAt.getTime() + w.relativeHours * HOUR);
    return { precision: w.precision === "approximate" ? "approximate" : "deadline", date: pacificParts(at).date, from: hhmm(at), through: null };
  }
  if (w.period) {
    if (w.period === "end_of_day") return { precision: "deadline", date: day, from: "24:00", through: null };
    const [start, end] = w.period === "afternoon" ? ["12:00", "18:00"] : w.period === "evening" ? ["17:00", "21:00"] : ["18:00", "23:59"];
    const from = day === post.date && post.hm > start! ? post.hm : start!;
    return { precision: "window", date: day, from, through: end! };
  }
  if (w.clock) {
    if (w.clockThrough) return { precision: "window", date: day, from: w.clock, through: w.clockThrough };
    // "by 8pm" stays a deadline and "around 2:30pm" approximate (the legacy schedule kept both); a plain
    // clock time ("landing 2:30pm") is shown as the hour after it.
    const precision = w.precision === "deadline" || w.precision === "approximate" ? w.precision : "exact";
    return { precision, date: day, from: w.clock, through: null };
  }
  if (w.precision === "date" && w.dayOffset !== null) return { precision: "date", date: day, from: null, through: null };
  return null;
}

/** A schedule an operator entered in Beijing time (admin corrections). */
export function manualSchedule(precision: SchedulePrecision, from: Date, through: Date): Schedule {
  if (precision === "deadline") return { precision, from: from.toISOString(), through: from.toISOString(), label: `北京时间预计 ${md(from)} ${hm(from)} 前` };
  if (precision === "approximate") return { precision, from: from.toISOString(), through: from.toISOString(), label: `北京时间约 ${md(from)} ${hm(from)}` };
  return { precision: precision === "exact" ? "window" : precision, from: from.toISOString(), through: through.toISOString(), label: `北京时间预计 ${beijingRange(from, through)}` };
}
