// Names, dates and grouping for daily, weekly and monthly reports.
import { REPORT_NAMES, REPORT_NAMES_EN, reportDateLabelEn, type ReportNavigationEntry, type ReportKind } from "@aihot/contracts/site";
import { beijingDate, isoWeekLabel, isoWeekRange, longDateEn, monthDay as engineMonthDay, monthDayEn } from "@aihot/contracts/time";
import { EDITION_WHEN, REPORTS, SITE, subjectAfter } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { RELEASE } from "@aihot/industry/taxonomy";
import { RELEASE_UNIT_EN } from "@aihot/industry/english";
import { monthDay, weekdayLong, weekdayShort } from "../../lib/format.ts";
import { feedPath, L, pagePath, translator, zh, type Locale, type Phrase } from "../../lib/i18n.ts";

export const KINDS: ReportKind[] = ["daily", "weekly", "monthly"];
export const KIND_PATH: Record<ReportKind, string> = { daily: "/daily", weekly: "/weekly", monthly: "/monthly" };

/** The kind of report a page's address is for, the English edition's (/en/weekly) as well. */
export function kindFromPath(pathname: string): ReportKind {
  const path = pagePath(pathname);
  if (path.startsWith("/weekly")) return "weekly";
  if (path.startsWith("/monthly")) return "monthly";
  return "daily";
}

/** What a kind of report is called: "日报" / "Daily". */
export const kindName = (kind: ReportKind, locale: Locale): string => (locale === "en" ? REPORT_NAMES_EN : REPORT_NAMES)[kind];

/** The kind's RSS feed, announced in the page head so a reader given the page finds it. */
export const feedLink = (kind: ReportKind, locale: Locale) => ({ tagName: "link", rel: "alternate", type: "application/rss+xml", title: `${SITE.name} ${kindName(kind, locale)}`, href: feedPath(`/feed/${kind}.xml`, locale) }) as const;

export function reportPath(kind: ReportKind, key: string): string {
  return `${KIND_PATH[kind]}/${key}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "November" of a month or a day (YYYY-MM…), in the English edition's month names (contracts/time.ts). */
const monthEn = (key: string) => longDateEn(key.slice(0, 7)).split(" ")[0]!;

/** "1 issue", "24 issues". */
const issuesEn = (n: number) => `${n} ${n === 1 ? "issue" : "issues"}`;

/** A figure's unit for a count, in both languages: the English one or many where the site gives both. */
type Unit = (count: number) => Phrase;
const counted = (zhUnit: string, en: { one: string; many: string } | undefined): Unit => (n) => L(zhUnit, en ? (n === 1 ? en.one : en.many) : zhUnit);

const { measure, noun } = REPORTS.entry;
/** "件大事" / "top stories": what an issue counts its entries in, in the site's words (REPORTS.entry, ENGLISH.reports.entry). */
const ENTRY = counted(`${measure}${noun}`, ENGLISH?.reports.entry);
export const entriesUnit = (count: number, locale: Locale): string => translator(locale)(ENTRY(count));

/**
 * "这一天的 4 件 AI 大事" / "The day's 4 top stories", "本周的 12 件 AI 大事" / "The week's 12 top stories",
 * "8 月的 20 件 AI 大事" / "August's 20 top stories" (the subject and REPORTS.entry from site/site.ts).
 */
export function headline(kind: ReportKind, key: string, count: number, locale: Locale): string {
  const t = translator(locale);
  const stories = count === 1 ? entriesUnit(count, locale) : `${count} ${entriesUnit(count, locale)}`;
  if (kind === "daily") return t(subjectAfter(`这一天的 ${count} ${measure}`, noun), `The day's ${stories}`);
  if (kind === "weekly") return t(subjectAfter(`本周的 ${count} ${measure}`, noun), `The week's ${stories}`);
  return t(subjectAfter(`${Number(key.slice(5, 7))} 月的 ${count} ${measure}`, noun), `${monthEn(key)}'s ${stories}`);
}

/** "09.16" / "Sep 16" for a story inside a week or month. */
export function shortDay(iso: string, locale: Locale): string {
  return locale === "en" ? monthDayEn(beijingDate(iso)) : beijingDate(iso).slice(5).replace("-", ".");
}

export interface ArchiveGroup {
  id: string;
  label: string;
  entries: ReportNavigationEntry[];
}

/**
 * The archive column: days grouped by month, weeks by the month their Monday falls in ("第2周" / "Week 2"),
 * months by year. Newest first, as the index comes.
 */
export function archiveGroups(kind: ReportKind, index: ReportNavigationEntry[], locale: Locale): ArchiveGroup[] {
  const t = translator(locale);
  const groups: ArchiveGroup[] = [];
  for (const entry of index) {
    const id = kind === "weekly" ? isoWeekRange(entry.key)!.start.slice(0, 7) : entry.key.slice(0, kind === "daily" ? 7 : 4);
    const previous = groups.at(-1);
    if (previous?.id === id) previous.entries.push(entry);
    else {
      const label = kind === "monthly" ? t(`${id} 年`, id) : t(`${id.slice(0, 4)} 年 ${Number(id.slice(5))} 月`, longDateEn(id));
      groups.push({ id, label, entries: [entry] });
    }
  }
  return groups;
}

/** An issue's mark in the archive column: a large number over a small word (a month's number stands alone). */
export function archiveMark(kind: ReportKind, key: string, locale: Locale): { big: string; small: string | null } {
  const t = translator(locale);
  if (kind === "daily") return { big: key.slice(8, 10), small: weekdayShort(key, locale) };
  if (kind === "weekly") {
    const { start } = isoWeekRange(key)!;
    return { big: key.slice(6), small: t(`${Number(start.slice(5, 7))}.${Number(start.slice(8, 10))} 起`, monthDayEn(start)) };
  }
  return { big: key.slice(5, 7), small: null };
}

/** The phone's three newest issues, with their labels from the same newest-first archive as the sidebar. */
export function recentIssues(kind: ReportKind, groups: ArchiveGroup[], today: string, locale: Locale): Array<{ key: string; label: string }> {
  const t = translator(locale);
  const recent = [];
  for (const group of groups) {
    for (const [position, issue] of group.entries.entries()) {
      const { key } = issue;
      let label: string;
      if (kind === "daily") label = key === today ? t("今天", "Today") : t(engineMonthDay(key, today), monthDayEn(key, today));
      else if (kind === "weekly") label = t(`${Number(group.id.slice(5))}月第${group.entries.length - position}周`, reportDateLabelEn("weekly", key));
      else label = t(`${Number(key.slice(5, 7))} 月`, monthEn(key));
      recent.push({ key, label });
      if (recent.length === 3) return recent;
    }
  }
  return recent;
}

/** The masthead's date block: a large figure and two small lines beside it. */
export function dateMark(kind: ReportKind, key: string, locale: Locale): { figure: string; top: string; bottom: string } {
  const t = translator(locale);
  if (kind === "daily") return { figure: key.slice(8, 10), top: t(`${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`, longDateEn(key.slice(0, 7))), bottom: weekdayLong(key, locale) };
  if (kind === "weekly") {
    const { start, end } = isoWeekRange(key)!;
    return { figure: key.slice(6), top: t(`${key.slice(0, 4)} 年第 ${Number(key.slice(6))} 周`, `Week ${Number(key.slice(6))}, ${key.slice(0, 4)}`), bottom: t(`${start.slice(5).replace("-", ".")} — ${end.slice(5).replace("-", ".")}`, reportDateLabelEn("weekly", key)) };
  }
  return { figure: key.slice(5, 7), top: t(`${key.slice(0, 4)} 年`, key.slice(0, 4)), bottom: t(`${Number(key.slice(5, 7))} 月`, monthEn(key)) };
}

/** When each kind comes out, for the masthead (the daily's time is the site's, EDITION_WHEN / ENGLISH.editionWhen). */
export const EDITION: Record<ReportKind, Phrase> = {
  daily: L(`${EDITION_WHEN.daily} 出刊`, `Published ${ENGLISH?.editionWhen.daily ?? EDITION_WHEN.daily}`),
  weekly: L("每周一出刊", "Published every Monday"),
  monthly: L("每月 1 日出刊", "Published on the 1st of each month"),
};

/**
 * The masthead's figures, in the order a reader wants them, in the site's words (REPORTS, ENGLISH.reports). Releases
 * of the pack's headline launch kind (RELEASE, "个新模型" for AI) count only where the pack has one; zero is left out.
 */
const UNITS = REPORTS.metricUnits;
const UNITS_EN = ENGLISH?.reports.metricUnits;
const METRICS: Array<[key: string, unit: Unit]> = [
  ["totalEvents", ENTRY],
  ["totalStories", ENTRY],
  ["sourcesCount", counted(UNITS.sourcesCount, UNITS_EN?.sourcesCount)],
  ["firstPartyEvents", counted(UNITS.firstPartyEvents, UNITS_EN?.firstPartyEvents)],
  ...(RELEASE ? [["modelsReleased", counted(RELEASE.unit, RELEASE_UNIT_EN)] as [string, Unit]] : []),
  ["selectedCount", counted(UNITS.selectedCount, UNITS_EN?.selectedCount)],
  ["reportsCovered", counted(UNITS.reportsCovered, UNITS_EN?.reportsCovered)],
];
export function metricItems(metrics: Record<string, number>, locale: Locale): Array<{ value: number; unit: string }> {
  const t = translator(locale);
  return METRICS.filter(([k]) => typeof metrics[k] === "number" && (k !== "modelsReleased" || metrics[k]! > 0)).map(([k, unit]) => ({ value: metrics[k]!, unit: t(unit(metrics[k]!)) }));
}

/**
 * "前一日 · 9月25日" / "Previous · Sep 25", "上一期 · 第 37 周" / "Previous · Week 37", "下一期 · 7 月" / "Next · July".
 * A day of another year than `now` (Beijing) carries its year.
 */
export function neighbourLabel(kind: ReportKind, key: string, direction: "prev" | "next", now: number = Date.now(), locale: Locale = "zh"): string {
  const t = translator(locale);
  if (kind === "daily") return t(`${direction === "prev" ? "前一日" : "后一日"} · ${monthDay(key, now)}`, `${direction === "prev" ? "Previous" : "Next"} · ${monthDay(key, now, "en")}`);
  const which = direction === "prev" ? t("上一期", "Previous") : t("下一期", "Next");
  return kind === "weekly" ? t(`${which} · 第 ${Number(key.slice(6))} 周`, `${which} · Week ${Number(key.slice(6))}`) : t(`${which} · ${Number(key.slice(5, 7))} 月`, `${which} · ${monthEn(key)}`);
}

/** Chinese numerals, for numbers a Chinese paper prints in words (Chinese pages only). */
const CN = zh("零一二三四五六七八九十");
/** Page numbers as a Chinese paper prints them: 1 → 一, 12 → 十二, 20 → 二十. */
function cnNumber(n: number): string {
  if (n <= 10) return CN[n]!;
  if (n < 20) return `${CN[10]}${CN[n - 10]}`;
  return `${CN[Math.floor(n / 10)]}${CN[10]}${n % 10 ? CN[n % 10] : ""}`;
}

/**
 * The line above the nameplate: "2026 年 9 月 26 日 · 星期六" / "Saturday, September 26, 2026",
 * "2026 年第 38 周 · 09.14 — 09.20" / "Week 38, 2026 · Sep 14–20", "2026 年 8 月" / "August 2026".
 */
export function dateLine(kind: ReportKind, key: string, locale: Locale = "zh"): string {
  const t = translator(locale);
  const m = dateMark(kind, key, locale);
  if (kind === "daily") return t(`${m.top} ${Number(key.slice(8, 10))} 日 · ${m.bottom}`, `${m.bottom}, ${longDateEn(key)}`);
  return kind === "weekly" ? `${m.top} · ${m.bottom}` : t(`${m.top} ${m.bottom}`, `${m.bottom} ${m.top}`);
}

/** What each kind is, under its nameplate. */
const MOTTO_EN = ENGLISH?.reports.motto ?? REPORTS.motto;
export const MOTTO: Record<ReportKind, Phrase> = {
  daily: L(`${REPORTS.motto} · 每日要闻`, `${MOTTO_EN} · Daily briefing`),
  weekly: L(`${REPORTS.motto} · 每周综述`, `${MOTTO_EN} · Weekly roundup`),
  monthly: L(`${REPORTS.motto} · 每月盘点`, `${MOTTO_EN} · Monthly review`),
};

export interface PeriodCell {
  key: string | null;
  /** Hover text: "9月26日 · 第 158 期" / "Sep 26 · Issue 158". */
  label: string;
  state: "current" | "issue" | "none" | "pad";
}

/**
 * The dot grid beside the date in the masthead: the days of this issue's month (dailies, Monday first),
 * the weeks of its year (weeklies) or the months of its year (monthlies), each marked as this issue,
 * an issue that exists, or none. This issue's own number (`current`) labels it, also when it is older
 * than the navigation.
 */
export function periodGrid(kind: ReportKind, key: string, index: ReportNavigationEntry[], current: number, locale: Locale = "zh"): { title: string; note: string; columns: number; heads: string[] | null; cells: PeriodCell[] } {
  const t = translator(locale);
  const numbers = new Map(index.map((e) => [e.key, e.issueNumber]));
  const cell = (k: string, name: string): PeriodCell => {
    const n = k === key ? current : numbers.get(k);
    return { key: k, label: n ? t(`${name} · 第 ${n} 期`, `${name} · Issue ${n}`) : t(`${name} · 未出刊`, `${name} · No issue`), state: k === key ? "current" : n !== undefined ? "issue" : "none" };
  };
  const count = (cells: PeriodCell[]) => cells.filter((c) => c.state === "issue" || c.state === "current").length;
  const year = key.slice(0, 4);
  if (kind === "daily") {
    const m = Number(key.slice(5, 7));
    const days = new Date(Date.UTC(Number(year), m, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(Number(year), m - 1, 1)).getUTCDay() + 6) % 7;
    const cells: PeriodCell[] = [
      ...Array.from({ length: lead }, (): PeriodCell => ({ key: null, label: "", state: "pad" })),
      ...Array.from({ length: days }, (_, i) => {
        const day = `${key.slice(0, 7)}-${pad(i + 1)}`;
        return cell(day, monthDay(day, undefined, locale));
      }),
    ];
    return { title: t(`${cnNumber(m)}月`, monthEn(key).slice(0, 3)), note: t(`本月 ${count(cells)} 期`, issuesEn(count(cells))), columns: 7, heads: t(["一", "二", "三", "四", "五", "六", "日"], ["M", "T", "W", "T", "F", "S", "S"]), cells };
  }
  if (kind === "weekly") {
    // 28 December always falls in its year's last ISO week.
    const weeks = Number(isoWeekLabel(`${year}-12-28`).slice(6));
    const cells = Array.from({ length: weeks }, (_, i) => {
      const k = `${year}-W${pad(i + 1)}`;
      const { start, end } = isoWeekRange(k)!;
      return cell(k, t(`第 ${i + 1} 周（${start.slice(5).replace("-", ".")}—${end.slice(5).replace("-", ".")}）`, `Week ${i + 1} (${reportDateLabelEn("weekly", k)})`));
    });
    return { title: t(`${year} 年`, year), note: t(`全年 ${count(cells)} 期`, issuesEn(count(cells))), columns: 13, heads: null, cells };
  }
  const cells = Array.from({ length: 12 }, (_, i) => cell(`${year}-${pad(i + 1)}`, t(`${i + 1} 月`, monthEn(`${year}-${pad(i + 1)}`))));
  return { title: t(`${year} 年`, year), note: t(`全年 ${count(cells)} 期`, issuesEn(count(cells))), columns: 6, heads: null, cells };
}
