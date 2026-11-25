// The site's English copy as the engine reads it. A site without an English edition writes
// `export const ENGLISH = null` in its site.ts; read through here, the engine sees one type on every site.
import { ENGLISH as SITE_ENGLISH } from "@aihot/site";
import type { EnglishEdition } from "./site-config.ts";
import type { Locale } from "./i18n.ts";

export const ENGLISH: EnglishEdition | null = SITE_ENGLISH;
export const READER_LANGUAGES: readonly Locale[] = ENGLISH ? ["zh", "en"] : ["zh"];

/** Shared cache lifetime while a public page or image waits for its English copy. */
export const WAITING_ENGLISH_SECONDS = 60;

/** Reader data is registered and requested under the same language prefix. */
export function readingApi(path: `/${string}` | "", lang: Locale): string {
  return (lang === "en" ? "/api/site/en" : "/api/site") + path;
}

/**
 * Han characters, as a regular expression both JavaScript and PostgreSQL read the same way (the worker finds what
 * to translate in SQL). A text without them already reads on English pages: names, model names, posts in English.
 */
export const HAN = "[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]";
const HAN_RE = new RegExp(HAN);

/** Whether a text is (still) Chinese: on an English page, one the worker has not translated yet. */
export function needsEnglish(text: string | null | undefined): text is string {
  return !!text && HAN_RE.test(text);
}
