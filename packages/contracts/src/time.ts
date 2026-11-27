// Beijing (Asia/Shanghai, fixed UTC+8, no DST) calendar helpers shared by web and backend.

export const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const OFFSET_MS = BEIJING_OFFSET_MS;

/** YYYY-MM-DD of the instant in Beijing time. */
export function beijingDate(instant: Date | string | number): string {
  const d = new Date(new Date(instant).getTime() + OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

/** HH:mm of the instant in Beijing time. */
export function beijingTime(instant: Date | string | number): string {
  const d = new Date(new Date(instant).getTime() + OFFSET_MS);
  return d.toISOString().slice(11, 16);
}

/** The instant as ISO 8601 in Beijing time, to the millisecond: "2026-09-26T08:07:13.000+08:00". */
export function beijingIso(instant: Date | string | number): string {
  return `${new Date(new Date(instant).getTime() + OFFSET_MS).toISOString().slice(0, 23)}+08:00`;
}

/**
 * "9月28日" of a calendar date (YYYY-MM-DD). Given `today` (YYYY-MM-DD, Beijing), a day of another year carries its
 * year, so an archived item is not read as this year's: "2019年2月19日".
 */
export function monthDay(date: string, today?: string): string {
  const year = today && date.slice(0, 4) !== today.slice(0, 4) ? `${date.slice(0, 4)}年` : "";
  return `${year}${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Nov 24" of a calendar date (YYYY-MM-DD); a day of another year than `today` carries it: "Feb 19, 2019". English pages. */
export function monthDayEn(date: string, today?: string): string {
  const md = `${MONTHS[Number(date.slice(5, 7)) - 1]!.slice(0, 3)} ${Number(date.slice(8, 10))}`;
  return today && date.slice(0, 4) !== today.slice(0, 4) ? `${md}, ${date.slice(0, 4)}` : md;
}

/** "November 24, 2026" of a calendar date, "November 2026" of a month label (YYYY-MM). English pages. */
export function longDateEn(date: string): string {
  const month = MONTHS[Number(date.slice(5, 7)) - 1]!;
  return date.length > 7 ? `${month} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}` : `${month} ${date.slice(0, 4)}`;
}

/** "9月29日" in Beijing time. */
export const beijingDay = (instant: Date | string | number) => monthDay(beijingDate(instant));

/** "9月29日 13:40" in Beijing time. */
export const beijingStamp = (instant: Date | string | number) => `${beijingDay(instant)} ${beijingTime(instant)}`;

/** The zone's name, for whatever takes one (a scheduler, a report's metadata, SQL `AT TIME ZONE`). */
export const BEIJING_TIMEZONE = "Asia/Shanghai" as const;

/** UTC instant of 00:00 Beijing on the given calendar day. */
export function beijingMidnight(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00+08:00`));
}

/** UTC instant of an HH:mm Beijing time on the given calendar day. */
export function beijingAt(date: string, time: string): Date {
  return new Date(Date.parse(`${date}T${time}:00+08:00`));
}

export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function beijingWeekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Tuesday" of a calendar date (YYYY-MM-DD). English pages. */
export function weekdayEn(date: string): string {
  return WEEKDAYS_EN[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** ISO week label (e.g. 2026-W38) of a calendar date. */
export function isoWeekLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday..Sunday calendar dates of an ISO week label. */
export function isoWeekRange(label: string): { start: string; end: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const start = new Date(mondayWeek1);
  start.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);
  const startDate = start.toISOString().slice(0, 10);
  if (isoWeekLabel(startDate) !== label) return null;
  return { start: startDate, end: addDays(startDate, 6) };
}

/** First and last day (YYYY-MM-DD) of a calendar month label such as 2026-09; null for anything else. */
export function monthRange(label: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(label);
  if (!m) return null;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]), 0);
  return { start: `${label}-01`, end: `${label}-${String(d.getUTCDate()).padStart(2, "0")}` };
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === date;
}
