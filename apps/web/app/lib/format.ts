import { beijingDate, beijingTime, beijingWeekday, monthDay as engineMonthDay, monthDayEn, weekdayEn } from "@aihot/contracts/time";
import { translator, zh, type Locale } from "./i18n.ts";

/**
 * "9月28日" / "Nov 28" of a calendar date (YYYY-MM-DD). A day of another year than `now` (Beijing) carries its year, so
 * an archived item is not read as this year's: "2019年2月19日", "Feb 19, 2019". The engine's monthDay does this only when given today.
 */
export function monthDay(date: string, now: number = Date.now(), locale: Locale = "zh"): string {
  return locale === "en" ? monthDayEn(date, beijingDate(now)) : engineMonthDay(date, beijingDate(now));
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

/** "周六" / "Sat" of a calendar date (YYYY-MM-DD). */
export function weekdayShort(date: string, locale: Locale = "zh"): string {
  return locale === "en" ? weekdayEn(date).slice(0, 3) : beijingWeekday(date).replace(zh("星期"), zh("周"));
}

/** "星期六" / "Saturday" of a calendar date (YYYY-MM-DD). */
export function weekdayLong(date: string, locale: Locale = "zh"): string {
  return locale === "en" ? weekdayEn(date) : beijingWeekday(date);
}

export function relativeTime(iso: string, now = Date.now(), locale: Locale = "zh"): string {
  return timeAgo(iso, now, locale) ?? beijingDate(iso);
}

/** "3 天前" / "3d ago" while that is under a month, else null: beside a full time, the date it would fall back to says nothing new. */
export function timeAgo(iso: string, now = Date.now(), locale: Locale = "zh"): string | null {
  const t = translator(locale);
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return t("刚刚", "just now");
  const m = Math.round(s / 60);
  if (m < 60) return t(`${m} 分钟前`, `${m}m ago`);
  const h = Math.round(m / 60);
  if (h < 24) return t(`${h} 小时前`, `${h}h ago`);
  const d = Math.round(h / 24);
  return d < 30 ? t(`${d} 天前`, `${d}d ago`) : null;
}

export function fullDateTime(iso: string): string {
  return `${beijingDate(iso)} ${beijingTime(iso)}`;
}

/** "9月24日 10:51" / "Sep 24, 10:51" (Beijing, carrying the year on archived dates), for lists that span days. */
export function monthDayTime(iso: string, locale: Locale = "zh"): string {
  const date = monthDay(beijingDate(iso), undefined, locale);
  return locale === "en" ? `${date}, ${beijingTime(iso)}` : `${date} ${beijingTime(iso)}`;
}

/** A count as the page's language writes it: 1240 in Chinese, 1,240 in English. */
export function formatCount(n: number, locale: Locale = "zh"): string {
  return locale === "en" ? n.toLocaleString("en-US") : String(n);
}

export function sourceInitial(name: string): string {
  const s = name.replace(/^[^\p{L}\p{N}]+/u, "");
  return (s[0] ?? "A").toUpperCase();
}
