import { matchPath } from "react-router";
import { MODULES } from "@aihot/site/modules";
import { ENGLISH } from "./english.ts";
import { inLanguage, localeOf, type Locale } from "./i18n.ts";

interface ReaderPage {
  path: string;
  file: string;
  id?: string;
  chineseOnly?: true;
}

/** Both editions render the same route module. Legal texts are published in Chinese only. */
export const READER_PAGES: readonly ReaderPage[] = [
  { path: "", file: "routes/home.tsx" },
  { path: "all", file: "routes/all.tsx" },
  { path: "all/search-busy", file: "routes/search-busy.tsx", id: "all-search-busy" },
  { path: "search-busy", file: "routes/search-busy.tsx", id: "search-busy" },
  { path: "items/:id", file: "routes/item.tsx" },
  { path: "items/:id/original", file: "routes/item-original.tsx", id: "item-original" },
  { path: "hot", file: "routes/hot.tsx" },
  { path: "story/:publicId", file: "routes/story.tsx" },
  { path: "daily", file: "routes/report-latest.tsx", id: "daily-latest" },
  { path: "daily/archive", file: "routes/daily-archive.tsx" },
  { path: "daily/:key", file: "routes/report-detail.tsx", id: "daily-detail" },
  { path: "weekly", file: "routes/report-latest.tsx", id: "weekly-latest" },
  { path: "weekly/:key", file: "routes/report-detail.tsx", id: "weekly-detail" },
  { path: "monthly", file: "routes/report-latest.tsx", id: "monthly-latest" },
  { path: "monthly/:key", file: "routes/report-detail.tsx", id: "monthly-detail" },
  { path: "topics", file: "routes/topics.tsx" },
  { path: "topics/:slug", file: "routes/topic.tsx", id: "topic" },
  { path: "topics/:slug/page/:page", file: "routes/topic.tsx", id: "topic-page" },
  { path: "about", file: "routes/about.tsx" },
  { path: "terms", file: "routes/terms.tsx", chineseOnly: true },
  { path: "privacy", file: "routes/privacy.tsx", chineseOnly: true },
  { path: "changelog", file: "routes/changelog.tsx" },
  { path: "feedback", file: "routes/feedback.tsx" },
  { path: "more", file: "routes/more.tsx" },
  { path: "starred", file: "routes/starred.tsx" },
  { path: "agent", file: "routes/agent.tsx" },
];

let english: readonly string[] | null = null;

/**
 * Every page with an English edition: the engine's and the modules' pages that say `en`. Read when first asked,
 * not on import, so a module's code may import this file (site-modules.ts).
 */
export function englishPages(): readonly string[] {
  if (!ENGLISH) return [];
  english ??= [
    ...READER_PAGES.filter((p) => !p.chineseOnly).map((p) => `/${p.path}`),
    ...MODULES.flatMap((m) => (m.pages ?? []).flatMap((p) => ("layout" in p ? p.pages : [p]))
      .filter((p) => (m.en || p.en) && !p.gray && !p.admin)
      .map((p) => `/${p.path}`)),
  ];
  return english;
}

/** Whether a Chinese page's path (without /en, query or hash) has an English edition. */
export function hasEnglish(pathname: string): boolean {
  return englishPages().some((pattern) => matchPath({ path: pattern, end: true }, pathname));
}

/**
 * Where a site link goes in this language: on an English page, a page that has an English edition is linked at
 * /en<path>; everything else (the Chinese pages, the api, feeds, files) as written.
 */
export function localizePath(to: string, locale: Locale): string {
  if (locale !== "en" || !to.startsWith("/") || to.startsWith("//") || localeOf(to) === "en") return to;
  const at = to.search(/[?#]/);
  const pathname = at < 0 ? to : to.slice(0, at);
  if (!hasEnglish(pathname)) return to;
  return inLanguage(pathname, locale) + (at < 0 ? "" : to.slice(at));
}
