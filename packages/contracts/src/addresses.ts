// Bare web addresses in text people post, read the way X shows them: the address runs until the sentence
// takes over again, and is drawn short. The api's HTML (textToHtml), the full RSS and the pages that draw a
// text themselves all read addresses here, so a post, its quote and its summary read alike everywhere.
import type { MentionRun } from "./mentions.ts";

// A bare address ends at whitespace, CJK text (punctuation, ideographs, full-width forms, kana, hangul),
// symbols and emoji (with their variation selector and joiner); trailing sentence punctuation belongs to the
// sentence, not the link.
const BARE_URL = /https?:\/\/[^\s<>"^`{|}\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af\u2600-\u27bf\ufe0f\u200d\u{1f300}-\u{1faff}]+/gu;
const TRAILING_PUNCT = /[.,;:!?*'"”’»…、。，；：！？）\]】}」』》]+$/;

/** An address without a closing bracket it never opened ("(see https://a.b/c)" keeps its ")"). */
function balanced(url: string): string {
  let u = url;
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
  return u;
}

/** The bare addresses in a text, where each starts, as a reader means them. */
export function* bareAddresses(text: string): Generator<{ at: number; url: string }> {
  for (const m of text.matchAll(BARE_URL)) {
    // "tibo.dog's site": the possessive belongs to the sentence.
    const url = balanced(m[0].replace(TRAILING_PUNCT, "").replace(/['’]s$/, ""));
    if (/^https?:\/\/[^/]+\.[^/]/.test(url)) yield { at: m.index, url };
  }
}

/** An address as X shows it: no scheme, no www, no lone trailing slash, at most 30 characters. */
export function shownAddress(url: string): string {
  const bare = Array.from(url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/^([^/]+)\/$/, "$1"));
  return bare.length > 30 ? `${bare.slice(0, 29).join("")}…` : bare.join("");
}

/** A text as runs: plain stretches, and each address shown short, linking to itself. */
export function addressRuns(text: string): MentionRun[] {
  const runs: MentionRun[] = [];
  let at = 0;
  for (const { at: start, url } of bareAddresses(text)) {
    if (start > at) runs.push(text.slice(at, start));
    runs.push({ text: shownAddress(url), href: url });
    at = start + url.length;
  }
  if (at < text.length) runs.push(text.slice(at));
  return runs;
}

/** A text with its addresses shown short, for a place a link cannot sit (a card that is a link as a whole). */
export function shortAddresses(text: string): string {
  return addressRuns(text).map((run) => (typeof run === "string" ? run : run.text)).join("");
}
