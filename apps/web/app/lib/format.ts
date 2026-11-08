import { beijingDate, beijingTime, beijingWeekday, monthDay as engineMonthDay } from "@aihot/contracts/time";

/**
 * "9月28日" of a calendar date (YYYY-MM-DD). A day of another year than `now` (Beijing) carries its year, so an
 * archived item is not read as this year's: "2019年2月19日". The engine's monthDay does this only when given today.
 */
export function monthDay(date: string, now: number = Date.now()): string {
  return engineMonthDay(date, beijingDate(now));
}

/** A list cut into runs of the same Beijing day, in the list's own order. */
export function byBeijingDay<T>(list: readonly T[], at: (entry: T) => string): Array<{ day: string; entries: T[] }> {
  const days: Array<{ day: string; entries: T[] }> = [];
  for (const entry of list) {
    const day = beijingDate(at(entry));
    const last = days.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}

/** "周六" of a calendar date (YYYY-MM-DD). */
export function weekdayShort(date: string): string {
  return beijingWeekday(date).replace("星期", "周");
}

export function relativeTime(iso: string, now = Date.now()): string {
  return timeAgo(iso, now) ?? beijingDate(iso);
}

/** "3 天前" while that is under a month, else null: beside a full time, the date it would fall back to says nothing new. */
export function timeAgo(iso: string, now = Date.now()): string | null {
  const t = Date.parse(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} 天前` : null;
}

export function fullDateTime(iso: string): string {
  return `${beijingDate(iso)} ${beijingTime(iso)}`;
}

/** "9月24日 10:51" (Beijing), for lists that span days. */
export function monthDayTime(iso: string): string {
  return `${monthDay(beijingDate(iso))} ${beijingTime(iso)}`;
}

export function sourceInitial(name: string): string {
  const s = name.replace(/^[^\p{L}\p{N}]+/u, "");
  return (s[0] ?? "A").toUpperCase();
}
