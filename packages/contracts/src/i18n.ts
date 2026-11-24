// The two languages' words, for every part of the engine: the reader's language comes from the page's address
// (/en/… is English), and text for readers is written in both languages where it is used — t("精选", "Top Picks"),
// L("精选", "Top Picks") outside a component — so neither drifts. Chinese that is data, not text for the reader
// (a prefix to match, a name from a feed), is marked zh("…"). The web adds the page's own language
// (apps/web/app/lib/i18n.ts); the architecture test "reader-facing web text has its English beside it" checks the
// web's text.

export type Locale = "zh" | "en";

/** Text in both languages, for text defined outside a component. */
export interface Phrase {
  zh: string;
  en: string;
}

/** A phrase in both languages: L("精选", "Top Picks"). */
export const L = (zh: string, en: string): Phrase => ({ zh, en });

/** Chinese that is data rather than reader-facing text (matched, stored or passed on as it is). */
export const zh = (text: string): string => text;

/**
 * Text a module may give in Chinese only: a plain string is Chinese only, and English pages leave out what it
 * labels (a page with no English edition yet, a part only Chinese readers need).
 */
export type Text = string | Phrase;

/** Whether text has its English: what English pages show of the parts modules give. */
export const isPhrase = (text: Text): text is Phrase => typeof text !== "string";

/** The entries a page in this language shows: on an English page, those whose text has its English. */
export function shownIn<T>(locale: Locale, entries: readonly T[], text: (entry: T) => Text): T[] {
  return locale === "zh" ? [...entries] : entries.filter((entry) => isPhrase(text(entry)));
}

/** The page's language from its address; a data request (/en.data, /en/all.data) follows the page it is for. */
export function localeOf(pathname: string): Locale {
  return /^\/en(?:[/.]|$)/.test(pathname) ? "en" : "zh";
}

/** A page's path without /en: what code matching the page's address (navigation, tabs, page checks) compares. */
export function pagePath(pathname: string): string {
  return pathname.replace(/^\/en(?=\/|$)/, "") || "/";
}

export interface Translate {
  /** The Chinese or the English, by the page's language. */
  <T>(zh: T, en: T): T;
  /** A phrase (or Chinese-only text) in the page's language. */
  (text: Text): string;
}

const make = (locale: Locale): Translate =>
  ((a: unknown, b?: unknown) => {
    if (b !== undefined) return locale === "en" ? b : a;
    return typeof a === "string" ? a : (a as Phrase)[locale];
  }) as Translate;

const TRANSLATORS: Record<Locale, Translate> = { zh: make("zh"), en: make("en") };

/** t(…) for a language: in loaders, meta and plain functions, which take the language from their caller. */
export function translator(locale: Locale): Translate {
  return TRANSLATORS[locale];
}
