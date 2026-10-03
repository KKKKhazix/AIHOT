import type { CodexResetPageData, CodexResetSitePage, CodexResetDay } from "@aihot/contracts/monitor";
import { codexResetPage } from "../monitor/read.ts";

export function siteCodexResetPage(page: CodexResetPageData, date?: string): CodexResetSitePage {
  const selectedDate = date ?? page.today;
  const ids = new Set(page.calendar.filter((m) => m.date === selectedDate).map((m) => m.eventId));
  const { activities: _activities, ...rest } = page;
  return { ...rest, selectedDate, events: page.events.filter((e) => ids.has(e.id)) };
}

export async function loadSiteCodexResetPage(date?: string, now = Date.now()) {
  return siteCodexResetPage(await codexResetPage(now), date);
}

export async function loadSiteCodexResetDay(date: string): Promise<CodexResetDay> {
  const page = await loadSiteCodexResetPage(date);
  return { date, version: page.version, events: page.events };
}
