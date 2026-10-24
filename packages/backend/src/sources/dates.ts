// Published dates as list pages, articles and JSON lists print them, read the same on every host.
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import type { SourceRow } from "./types.ts";

/** The offset a source's article pages print their dates in: its detail rules' own, else its listing's. */
export function articleUtcOffset(config: SourceRow["config"]): string | undefined {
  return config.detail?.publishedAtUtcOffset ?? config.publishedAtUtcOffset;
}

/**
 * A time followed by its zone: "10:00Z", "10:00:00+08:00", "10:00:00 +0000", "10:00 PM GMT", "10:00 EST".
 * CST is no zone here: Date.parse reads US Central, Chinese pages mean China, so it is read in the source's offset.
 */
const EXPLICIT_ZONE = /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AP]M\s*)?(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC?|[EMP][SD]T|CDT)\b/i;

function calendarDay(y: string | number, mo: string | number, d: string | number): boolean {
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d);
}

function atOffset(y: string | number, mo: string | number, d: string | number, h: string | number, mi: string | number, s: string | number, utcOffset: string): Date | null {
  if (!calendarDay(y, mo, d) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  const p = (n: string | number) => String(n).padStart(2, "0");
  const t = Date.parse(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}${utcOffset}`);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * A published date as a source prints it. Date.parse is kept only where it reads the same
 * on every host: a time with its zone. A calendar day always belongs to the source, including ISO date-only text. Anything else it would read
 * in the server's local zone (UTC in Docker), so "2026-09-26 10:00" is read in the source's offset instead.
 */
export function parseLooseDate(value: string | null | undefined, utcOffset = "+08:00"): Date | null {
  if (!value) return null;
  // "Sep 26, 2026 at 10:30": "at" joins a date and its time like a space.
  const v = value.trim().replace(/(\d),?\s+at\s+(?=\d{1,2}:\d{2})/gi, "$1 ");
  if (!v) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (compact) return atOffset(compact[1]!, compact[2]!, compact[3]!, compact[4]!, compact[5]!, compact[6]!, utcOffset);
  const yearFirst = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:(?:T|\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  const monthFirst = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})(?:(?:T|\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  const numeric = yearFirst ?? monthFirst?.map((part, i, match) => i === 1 ? match[3]! : i === 2 ? match[1]! : i === 3 ? match[2]! : part);
  if (numeric && !calendarDay(numeric[1]!, numeric[2]!, numeric[3]!)) return null;
  const english = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/i.exec(v)
    ?? /\b(\d{1,2})\s+([a-z]{3,9})\.?[,]?\s+(\d{2}|\d{4})\b/i.exec(v)?.map((part, i, match) => i === 1 ? match[2]! : i === 2 ? match[1]! : part);
  if (english) {
    if (english[3]!.length === 2) english[3] = String(Number(english[3]) + (Number(english[3]) < 50 ? 2000 : 1900));
    const month = Date.parse(`${english[1]} 1, ${english[3]} 00:00:00 GMT`);
    if (!Number.isFinite(month) || !calendarDay(english[3]!, new Date(month).getUTCMonth() + 1, english[2]!)) return null;
  }
  if (!numeric && !english) return null;
  const text = v.replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  if (EXPLICIT_ZONE.test(v)) {
    const direct = Date.parse(text);
    if (Number.isFinite(direct)) return new Date(direct);
    if (!numeric) return null;
  }
  // 2026-09-26 / 2026/09/26 / 2026-09-26T10:00 / 2026年9月26日 (+ optional time), interpreted in the given offset.
  const m = numeric;
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
    const meridiem = /\d:\d{2}(?::\d{2})?\s*([AP]M)\b/i.exec(v)?.[1]?.toUpperCase();
    if (meridiem && (Number(h) < 1 || Number(h) > 12)) return null;
    const hour = meridiem ? Number(h) % 12 + (meridiem === "PM" ? 12 : 0) : h;
    return atOffset(y!, mo!, d!, hour, mi, s, utcOffset);
  }
  // Parse English wall-clock fields in UTC so the host's daylight-saving rules cannot shift them.
  const en = Date.parse(`${text} GMT`);
  const englishDay = english && !/\d:\d/.test(text) ? Date.parse(`${english[1]} ${english[2]}, ${english[3]} GMT`) : NaN;
  if (!Number.isFinite(en) && !Number.isFinite(englishDay)) return null;
  const utc = new Date(Number.isFinite(en) ? en : englishDay);
  return atOffset(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(), utcOffset);
}

/** A source's claim keeps its precision, apart from the instant used for ordering and windows. */
export interface PublicationDate {
  publishedAt: Date | null;
  /** YYYY-MM-DD for a calendar day; ISO timestamp for a real time; null for unknown. */
  publicationTime: string | null;
}

export function readPublicationDate(value: string | null | undefined, utcOffset = "+08:00"): PublicationDate {
  const publishedAt = parseLooseDate(value, utcOffset);
  if (!publishedAt) return { publishedAt: null, publicationTime: null };
  const timed = /\d{1,2}:\d{2}/.test(value!) || /^\d{14}$/.test(value!.trim());
  if (timed) return { publishedAt, publicationTime: publishedAt.toISOString() };
  const offsetMs = Date.UTC(2000, 0, 1) - atOffset(2000, 1, 1, 0, 0, 0, utcOffset)!.getTime();
  return { publishedAt, publicationTime: new Date(publishedAt.getTime() + offsetMs).toISOString().slice(0, 10) };
}

/** Legacy timestamps have lost their source precision; midnight never tells us which it was. */
export function describePublicationTime(at: Date | null, source: string | null | undefined): string {
  if (!at) return "未知";
  if (!source) return `${beijingDate(at)} ${beijingTime(at)}（历史记录，原始精度未知）`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return `${source}（原文仅有日期，时刻未知）`;
  return `${beijingDate(at)} ${beijingTime(at)}（北京时间）`;
}

const RELATIVE_UNITS: Record<string, number> = { 秒: 1e3, 分钟: 60e3, 分: 60e3, 小时: 3600e3, 天: 86400e3, second: 1e3, minute: 60e3, min: 60e3, hour: 3600e3, hr: 3600e3, day: 86400e3 };

/**
 * A page's own element printing an age instead of a date ("20小时前", "2天前", "昨天", "3 hours ago"), counted back
 * from `now`, the moment it was read. Only the whole text of a date rule's element is read this way: a sentence
 * that mentions "两天前" is no date. Some listing pages print the age for an article's first days and the date
 * only after, so every new article came in undated and missed that day's news. Hours and minutes keep a time,
 * however many; days keep the calendar day in the source's offset.
 */
export function readRelativeDate(value: string | null | undefined, now: Date, utcOffset = "+08:00"): PublicationDate {
  const v = collapse(value);
  const none = { publishedAt: null, publicationTime: null };
  if (!v) return none;
  let ms: number | null = null;
  let unit = "";
  if (/^(刚刚|just now)$/i.test(v)) ms = 0;
  else if (/^(昨天|yesterday)$/i.test(v)) [ms, unit] = [86400e3, "day"];
  else if (v === "前天") [ms, unit] = [2 * 86400e3, "day"];
  else {
    const m = /^(\d{1,3})\s*(秒|分钟|分|小时|天)前$/.exec(v) ?? /^(\d{1,3})\s+(second|minute|min|hour|hr|day)s?\s+ago$/i.exec(v);
    if (m) [ms, unit] = [Number(m[1]) * RELATIVE_UNITS[m[2]!.toLowerCase()]!, m[2]!.toLowerCase()];
  }
  if (ms === null) return none;
  const at = new Date(now.getTime() - ms);
  // The text's own unit sets the precision: "47小时前" keeps its time, though it is more than a day back.
  if (unit !== "天" && unit !== "day") return { publishedAt: at, publicationTime: at.toISOString() };
  const offsetMs = Date.UTC(2000, 0, 1) - atOffset(2000, 1, 1, 0, 0, 0, utcOffset)!.getTime();
  const day = new Date(at.getTime() + offsetMs).toISOString().slice(0, 10);
  return { publishedAt: atOffset(day.slice(0, 4), day.slice(5, 7), day.slice(8, 10), 0, 0, 0, utcOffset), publicationTime: day };
}

const collapse = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
