// The site's English copy as the engine reads it. A site without an English edition writes
// `export const ENGLISH = null` in its site.ts; read through here, the engine sees one type on every site.
import { ENGLISH as SITE_ENGLISH } from "@aihot/site";
import type { EnglishEdition } from "./site-config.ts";

export const ENGLISH: EnglishEdition | null = SITE_ENGLISH;
