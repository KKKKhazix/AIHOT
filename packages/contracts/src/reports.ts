// Daily, weekly and monthly report contract: kinds, calendar validation, names, date labels and DTOs.
import type { MentionTarget } from "./mentions.ts";
import { isoWeekRange, isValidDate, longDateEn, monthDay, monthDayEn, monthRange } from "./time.ts";

export const REPORT_KINDS = ["daily", "weekly", "monthly"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type PeriodKind = "weekly" | "monthly";

export function isReportKind(value: string): value is ReportKind {
  return value === "daily" || value === "weekly" || value === "monthly";
}

/** Whether `key` is a real calendar date (daily), ISO week (weekly) or calendar month (monthly). */
export function isReportKey(kind: ReportKind, key: string): boolean {
  if (kind === "daily") return isValidDate(key);
  return (kind === "weekly" ? isoWeekRange(key) : monthRange(key)) !== null;
}

/** What each kind of report is called. */
export const REPORT_NAMES: Record<ReportKind, string> = { daily: "日报", weekly: "周报", monthly: "月报" };
export const REPORT_NAMES_EN: Record<ReportKind, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/** An issue's date as Chinese readers write and search it: "10月17日", "10月12日—18日" (or "9月28日—10月4日"), "2026年10月". */
export function reportDateLabel(kind: ReportKind, key: string): string {
  if (kind === "daily") return monthDay(key);
  if (kind === "monthly") return `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月`;
  const { start, end } = isoWeekRange(key)!;
  return `${monthDay(start)}—${start.slice(5, 7) === end.slice(5, 7) ? `${Number(end.slice(8, 10))}日` : monthDay(end)}`;
}

/** reportDateLabel on English pages: "Oct 17", "Oct 12–18" (or "Sep 28 – Oct 4"), "October 2026". */
export function reportDateLabelEn(kind: ReportKind, key: string): string {
  if (kind === "daily") return monthDayEn(key);
  if (kind === "monthly") return longDateEn(key);
  const { start, end } = isoWeekRange(key)!;
  return start.slice(5, 7) === end.slice(5, 7) ? `${monthDayEn(start)}–${Number(end.slice(8, 10))}` : `${monthDayEn(start)} – ${monthDayEn(end)}`;
}

export interface ReportCitation {
  itemId: string | null;
  title: string;
  summary: string | null;
  sourceId?: string | null;
  sourceName: string;
  sourceUrl: string;
  sourceIconUrl: string | null;
  sourceIconSrcSet?: string;
  firstParty: boolean;
  /** When the cited report was published, if it is still in the database. */
  publishedAt: string | null;
  /** False once the item was withdrawn; the citation then shows as removed. */
  available: boolean;
  /** A daily entry: other sources that reported the event by the issue's cutoff. */
  otherSources?: number;
  /** That event's page (publicId). */
  storyId?: string;
  /** A daily entry's other developments of the event, or reports of the launch merged into it: the first few it lists (titles only). */
  related?: ReportCitation[];
  /** A daily entry whose event an earlier daily covered: that issue's date. */
  followUp?: string;
}

export interface ReportDetail {
  kind: ReportKind;
  key: string;
  /** The issue's place among the existing issues of its kind, oldest first ("第 N 期"). */
  issueNumber: number;
  title: string;
  generatedAt: string;
  lead: { title: string; leadParagraph: string } | null;
  /** The still-public item the front page leads with (its headline links there). */
  leadItemId: string | null;
  overview: string | null;
  highlights: ReportCitation[];
  /** As edited: daily categories, weekly and monthly themes. */
  sections: Array<{ key?: string; label: string; summary: string | null; items: ReportCitation[] }>;
  flashes: ReportCitation[];
  /**
   * The front page's picture: from the lead item (a daily's lead, a weekly or monthly's first highlight),
   * else from another public report of that event. Captioned with the story when it is not the lead's own.
   */
  cover: { url: string; srcSet?: string; width: number | null; height: number | null; caption: string | null } | null;
  metrics: Record<string, number>;
  readingMinutes: number;
  prev: string | null;
  next: string | null;
  /** The pages its paragraphs and summaries name (mentions.ts). */
  mentions: MentionTarget[];
}

export interface ReportIndexEntry {
  key: string;
  issueNumber: number;
  title: string | null;
  count: number;
}

export interface ReportIndexResponse {
  kind: ReportKind;
  items: ReportIndexEntry[];
}

export interface ReportNavigationEntry {
  key: string;
  issueNumber: number;
  title?: string | null;
  count?: number;
}

/** The latest report page: its archive selector and the report in one request. */
export interface ReportLatestPage {
  index: ReportNavigationEntry[];
  report: ReportDetail | null;
}

/** A report's archive selector, or one month of the daily archive. */
export interface ReportNavigationResponse {
  items: ReportNavigationEntry[];
}
