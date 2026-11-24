// The reader's language on the web. The address decides it: /en and every page under /en/ are English, the rest
// Chinese, so the CDN (which keeps one copy per address) never serves one language to a reader of the other, and a
// shared link opens in the language it was shared in. No cookie, no Accept-Language, no redirect by browser language.
// The words themselves (t, L, zh, Phrase, Text) are the engine's, in @aihot/contracts/i18n.
import { matchPath, useLocation } from "react-router";
import { MODULES } from "@aihot/site/modules";
import { localeOf, pagePath, translator, type Locale, type Translate } from "@aihot/contracts/i18n";

export { isPhrase, L, localeOf, pagePath, shownIn, translator, zh } from "@aihot/contracts/i18n";
export type { Locale, Phrase, Text, Translate } from "@aihot/contracts/i18n";

export function useLocale(): Locale {
  return localeOf(useLocation().pathname);
}

/** t(…) for the page being rendered; the same function for every render in one language. */
export function useT(): Translate {
  return translator(useLocale());
}

/** The engine's pages that have an English edition at /en<path>. */
const ENGINE_ENGLISH = [
  "/", "/all", "/all/search-busy", "/search-busy", "/items/:id", "/items/:id/original", "/hot", "/story/:publicId",
  "/daily", "/daily/archive", "/daily/:key", "/weekly", "/weekly/:key", "/monthly", "/monthly/:key",
  "/topics", "/topics/:slug", "/topics/:slug/page/:page", "/about", "/feedback", "/more", "/starred", "/agent",
];

let english: readonly string[] | null = null;

/**
 * Every page with an English edition: the engine's and the modules' pages that say `en`. Read when first asked,
 * not on import, so a module's code may import this file (site-modules.ts).
 */
export function englishPages(): readonly string[] {
  english ??= [
    ...ENGINE_ENGLISH,
    ...MODULES.flatMap((m) => (m.pages ?? []).flatMap((p) => ("layout" in p ? p.pages : [p])))
      .filter((p) => p.en && !p.gray && !p.admin)
      .map((p) => `/${p.path}`),
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
  return `/en${pathname === "/" ? "" : pathname}${at < 0 ? "" : to.slice(at)}`;
}

/** A page's path in the other language: what the language switch links to; null when there is no such page. */
export function counterpart(pathname: string, to: Locale): string | null {
  if (to === "zh") return pagePath(pathname);
  if (localeOf(pathname) === "en") return pathname;
  return hasEnglish(pathname) ? `/en${pathname === "/" ? "" : pathname}` : null;
}
