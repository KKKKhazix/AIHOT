import { SITE, subjectAfter } from "@aihot/industry/site";
// Names, dates and grouping for daily, weekly and monthly reports.
import type { ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { beijingWeekday } from "@aihot/contracts/time";

export const KINDS: ReportKind[] = ["daily", "weekly", "monthly"];
export const KIND_PATH: Record<ReportKind, string> = { daily: "/daily", weekly: "/weekly", monthly: "/monthly" };
export const KIND_LABEL: Record<ReportKind, string> = { daily: "日报", weekly: "周报", monthly: "月报" };

export function kindFromPath(pathname: string): ReportKind {
  if (pathname.startsWith("/weekly")) return "weekly";
  if (pathname.startsWith("/monthly")) return "monthly";
  return "daily";
}

export function reportPath(kind: ReportKind, key: string): string {
  return `${KIND_PATH[kind]}/${key}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Monday and Sunday (YYYY-MM-DD) of an ISO week key such as 2026-W38. */
export function isoWeekRange(key: string): [string, string] {
  const [y, w] = key.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (w - 1) * 7 * 86400000);
  return [ymd(monday), ymd(new Date(monday.getTime() + 6 * 86400000))];
}

/** First and last day of a month key such as 2026-08. */
export function monthRange(key: string): [string, string] {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return [`${key}-01`, ymd(new Date(Date.UTC(y, m, 0)))];
}

/** "这一天的 4 件 AI 大事" / "本周的 12 件 AI 大事" / "8 月的 20 件 AI 大事" (the subject from industry/site.ts). */
export function headline(kind: ReportKind, key: string, count: number): string {
  if (kind === "daily") return subjectAfter(`这一天的 ${count} 件`, "大事");
  if (kind === "weekly") return subjectAfter(`本周的 ${count} 件`, "大事");
  return subjectAfter(`${Number(key.slice(5, 7))} 月的 ${count} 件`, "大事");
}

/** "09.16" for a story inside a week or month. */
export function shortDay(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600000);
  return `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

/** Month-day label of a daily key: "9月26日". */
export function dayLabel(key: string): string {
  return `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;
}


export interface ArchiveGroup {
  id: string;
  label: string;
  entries: Array<ReportNavigationEntry & { short: string }>;
}

/**
 * The archive column: days grouped by month, weeks by the month their Monday falls in ("第2周"),
 * months by year. Newest first, as the index comes.
 */
export function archiveGroups(kind: ReportKind, index: ReportNavigationEntry[]): ArchiveGroup[] {
  const groups: ArchiveGroup[] = [];
  const push = (id: string, label: string, e: ReportNavigationEntry & { short: string }) => {
    const g = groups[groups.length - 1];
    if (g && g.id === id) g.entries.push(e);
    else groups.push({ id, label, entries: [e] });
  };
  if (kind === "weekly") {
    const byMonth = new Map<string, string[]>();
    for (const e of index) {
      const m = isoWeekRange(e.key)[0].slice(0, 7);
      byMonth.set(m, [...(byMonth.get(m) ?? []), e.key]);
    }
    for (const e of index) {
      const m = isoWeekRange(e.key)[0].slice(0, 7);
      const weeks = [...byMonth.get(m)!].sort();
      push(m, `${m.slice(0, 4)} 年 ${Number(m.slice(5))} 月`, { ...e, short: `第${weeks.indexOf(e.key) + 1}周` });
    }
    return groups;
  }
  for (const e of index) {
    if (kind === "daily") push(e.key.slice(0, 7), `${e.key.slice(0, 4)} 年 ${Number(e.key.slice(5, 7))} 月`, { ...e, short: `${Number(e.key.slice(8, 10))} 日` });
    else push(e.key.slice(0, 4), `${e.key.slice(0, 4)} 年`, { ...e, short: `${Number(e.key.slice(5, 7))} 月` });
  }
  return groups;
}

/** An issue's mark in the archive column: a large number over a small word (a month's number stands alone). */
export function archiveMark(kind: ReportKind, key: string): { big: string; small: string | null } {
  if (kind === "daily") return { big: key.slice(8, 10), small: beijingWeekday(key).replace("星期", "周") };
  if (kind === "weekly") {
    const start = isoWeekRange(key)[0];
    return { big: key.slice(6), small: `${Number(start.slice(5, 7))}.${Number(start.slice(8, 10))} 起` };
  }
  return { big: key.slice(5, 7), small: null };
}

/** Short chip label for the phone switcher: "今天", "9月26日", "9月第2周", "8 月". */
export function chipLabel(kind: ReportKind, key: string, index: ReportNavigationEntry[], today: string): string {
  if (kind === "daily") return key === today ? "今天" : dayLabel(key);
  if (kind === "monthly") return `${Number(key.slice(5, 7))} 月`;
  const group = archiveGroups("weekly", index).find((g) => g.entries.some((e) => e.key === key));
  const entry = group?.entries.find((e) => e.key === key);
  return group && entry ? `${Number(group.id.slice(5))}月${entry.short}` : key;
}

/** 使用完整序列提供的期号，不能从截断的导航长度推算。 */
export function issueNumber(index: ReportNavigationEntry[], key: string): number | null {
  const n = index.find((e) => e.key === key)?.issueNumber;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** The masthead's date block: a large figure and two small lines beside it. */
export function dateMark(kind: ReportKind, key: string): { figure: string; top: string; bottom: string } {
  if (kind === "daily") return { figure: key.slice(8, 10), top: `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`, bottom: beijingWeekday(key) };
  if (kind === "weekly") {
    const [a, b] = isoWeekRange(key);
    return { figure: key.slice(6), top: `${key.slice(0, 4)} 年第 ${Number(key.slice(6))} 周`, bottom: `${a.slice(5).replace("-", ".")} — ${b.slice(5).replace("-", ".")}` };
  }
  return { figure: key.slice(5, 7), top: `${key.slice(0, 4)} 年`, bottom: `${Number(key.slice(5, 7))} 月` };
}

/** When each kind comes out (F10), for the masthead. */
export const EDITION: Record<ReportKind, string> = { daily: "每天 08:00 出刊", weekly: "每周一出刊", monthly: "每月 1 日出刊" };

/** The masthead's figures, in the order a reader wants them; zero model releases is left out. */
const METRICS: Array<[key: string, unit: string]> = [
  ["totalEvents", "件大事"],
  ["totalStories", "件大事"],
  ["sourcesCount", "个来源"],
  ["firstPartyEvents", "件一手发布"],
  ["modelsReleased", "个新模型"],
  ["selectedCount", "条精选"],
  ["reportsCovered", "期日报"],
];
export function metricItems(metrics: Record<string, number>): Array<{ value: number; unit: string }> {
  return METRICS.filter(([k]) => typeof metrics[k] === "number" && (k !== "modelsReleased" || metrics[k]! > 0)).map(([k, unit]) => ({ value: metrics[k]!, unit }));
}

/** "前一日 · 9月25日", "上一期 · 第 37 周", "下一期 · 7 月". */
export function neighbourLabel(kind: ReportKind, key: string, direction: "prev" | "next"): string {
  if (kind === "daily") return `${direction === "prev" ? "前一日" : "后一日"} · ${dayLabel(key)}`;
  const which = direction === "prev" ? "上一期" : "下一期";
  return kind === "weekly" ? `${which} · 第 ${Number(key.slice(6))} 周` : `${which} · ${Number(key.slice(5, 7))} 月`;
}

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
/** Page numbers as a Chinese paper prints them: 1 → 一, 12 → 十二, 20 → 二十. */
export function cnNumber(n: number): string {
  if (n <= 10) return CN[n]!;
  if (n < 20) return `十${CN[n - 10]}`;
  return `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ""}`;
}

/** The line above the nameplate: "2026 年 9 月 26 日 · 星期六", "2026 年第 38 周 · 09.14 — 09.20", "2026 年 8 月". */
export function dateLine(kind: ReportKind, key: string): string {
  const m = dateMark(kind, key);
  if (kind === "daily") return `${m.top} ${Number(key.slice(8, 10))} 日 · ${m.bottom}`;
  return kind === "weekly" ? `${m.top} · ${m.bottom}` : `${m.top} ${m.bottom}`;
}

/** What each kind is, under its nameplate. */
export const MOTTO: Record<ReportKind, string> = { daily: `${SITE.subject} · 每日要闻`, weekly: `${SITE.subject} · 每周综述`, monthly: `${SITE.subject} · 每月盘点` };

export interface PeriodCell {
  key: string | null;
  /** Hover text: "9月26日 · 第 158 期". */
  label: string;
  state: "current" | "issue" | "none" | "pad";
}

/** ISO week number of a date (YYYY-MM-DD). */
function isoWeek(day: string): number {
  const d = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * 86400000);
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.floor((thursday.getTime() - jan1.getTime()) / 86400000 / 7) + 1;
}

/**
 * The dot grid beside the date in the masthead: the days of this issue's month (dailies, Monday first),
 * the weeks of its year (weeklies) or the months of its year (monthlies), each marked as this issue,
 * an issue that exists, or none.
 */
export function periodGrid(kind: ReportKind, key: string, index: ReportNavigationEntry[], currentIssueNumber?: number): { title: string; note: string; columns: number; heads: string[] | null; cells: PeriodCell[] } {
  const exists = new Set(index.map((e) => e.key));
  const cell = (k: string, name: string): PeriodCell => {
    const n = k === key && currentIssueNumber !== undefined && Number.isInteger(currentIssueNumber) && currentIssueNumber > 0 ? currentIssueNumber : issueNumber(index, k);
    const published = k === key || exists.has(k);
    return { key: k, label: n ? `${name} · 第 ${n} 期` : `${name} · ${published ? "已出刊" : "未出刊"}`, state: k === key ? "current" : exists.has(k) ? "issue" : "none" };
  };
  const count = (cells: PeriodCell[]) => cells.filter((c) => c.state === "issue" || c.state === "current").length;
  const year = key.slice(0, 4);
  if (kind === "daily") {
    const m = Number(key.slice(5, 7));
    const days = new Date(Date.UTC(Number(year), m, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(Number(year), m - 1, 1)).getUTCDay() + 6) % 7;
    const cells: PeriodCell[] = [
      ...Array.from({ length: lead }, (): PeriodCell => ({ key: null, label: "", state: "pad" })),
      ...Array.from({ length: days }, (_, i) => cell(`${key.slice(0, 7)}-${pad(i + 1)}`, `${m}月${i + 1}日`)),
    ];
    return { title: `${cnNumber(m)}月`, note: `本月 ${count(cells)} 期`, columns: 7, heads: ["一", "二", "三", "四", "五", "六", "日"], cells };
  }
  if (kind === "weekly") {
    const weeks = isoWeek(`${year}-12-28`);
    const cells = Array.from({ length: weeks }, (_, i) => {
      const k = `${year}-W${pad(i + 1)}`;
      const [a, b] = isoWeekRange(k);
      return cell(k, `第 ${i + 1} 周（${a.slice(5).replace("-", ".")}—${b.slice(5).replace("-", ".")}）`);
    });
    return { title: `${year} 年`, note: `全年 ${count(cells)} 期`, columns: 13, heads: null, cells };
  }
  const cells = Array.from({ length: 12 }, (_, i) => cell(`${year}-${pad(i + 1)}`, `${i + 1} 月`));
  return { title: `${year} 年`, note: `全年 ${count(cells)} 期`, columns: 6, heads: null, cells };
}
