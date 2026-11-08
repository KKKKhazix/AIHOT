// Names in the site's own text (an article's summary, an event's overview, a report's paragraphs) that
// lead to the page about them, such as a model's page or a company's topic. The api finds which pages a
// page's texts name; the page links them as it draws the texts, so both read names the same way.
import { bareAddresses, shownAddress } from "./addresses.ts";

/**
 * A page that names in the site's own text can link to, and the names it goes by. A null `href` gathers
 * names no page may take (two pages share them): they never link, but still hold their place.
 */
export interface MentionTarget {
  href: string | null;
  names: string[];
}

/** A stretch of text: plain, a name linking to its page, or a web address linking to itself. */
export type MentionRun = string | { text: string; href: string };

// Spaces and hyphens inside a name may be written either way ("V4.1 Flash", "V4.1-Flash"). Dashes used as
// punctuation (——) are not among them.
const HYPHENS = "_\u2010\u2011\u2012\u2013-";
const SEPARATOR = new RegExp(`[\\s${HYPHENS}]`);
const WORD = /[A-Za-z0-9]/;
const JOINER = /[-_./]/;

/** A text without its separators, lowercased, and where each of its characters came from. */
function skeleton(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (SEPARATOR.test(c)) continue;
    const lower = c.toLowerCase();
    out += lower.length === 1 ? lower : c;
    at.push(i);
  }
  return { text: out, at };
}

const stripped = (s: string) => [...s].filter((c) => !SEPARATOR.test(c)).join("");

/**
 * What a lowercased text whose whitespace runs are single spaces (the site's search text) holds where it
 * mentions `name`: `key`, once `separators` are taken out. Holding it is not yet a mention; `linkMentions`
 * reads the edges and the case.
 */
export function mentionSearch(name: string): { key: string; separators: string } {
  return { key: skeleton(name).text, separators: ` ${HYPHENS}` };
}

interface Name {
  text: string;
  key: string;
  /** A name without a version number matches only in its own case ("Command A", not "command a"). */
  exact: string | null;
  href: string | null;
}

function namesOf(targets: readonly MentionTarget[]): Name[] {
  const names = targets.flatMap((t) => t.names.map((text) => ({ text, key: skeleton(text).text, exact: /\d/.test(text) ? null : stripped(text), href: t.href })));
  return names.filter((n) => n.key).sort((a, b) => b.key.length - a.key.length);
}

/**
 * A Latin or numeric edge of a name must not continue a word: "Meta" is not in "Metaverse", "K3" not in
 * "K3.1". A Latin word after a name makes it the start of a longer one ("Claude Code", "GPT-5.5 Pro", a
 * company before its product), which is another thing than the page the shorter name leads to.
 */
function bounded(text: string, start: number, end: number): boolean {
  const word = (i: number) => WORD.test(text[i] ?? "");
  const joined = (i: number, next: number) => JOINER.test(text[i] ?? "") && word(next);
  if (word(start) && (word(start - 1) || joined(start - 1, start - 2))) return false;
  if (word(end - 1) && joined(end, end + 1)) return false;
  let next = end;
  while (text[next] === " " || text[next] === "\u00a0") next++;
  return !word(next);
}

interface Span {
  start: number;
  end: number;
  name: Name;
  /** It may not link here (its edges, its case, a shared name) but holds its place. */
  held: boolean;
}

/**
 * The names a text mentions, in order and never overlapping: of two starting together the longer wins. A
 * name that may not link where it stands still holds its place, so a shorter name inside it does not link
 * instead ("阿里" in "阿里巴巴 Qwen").
 */
function spans(text: string, names: readonly Name[]): Span[] {
  const sk = skeleton(text);
  const found: Span[] = [];
  for (const name of names) {
    for (let i = sk.text.indexOf(name.key); i !== -1; i = sk.text.indexOf(name.key, i + 1)) {
      const start = sk.at[i];
      const end = sk.at[i + name.key.length - 1] + 1;
      const held = name.href === null || !bounded(text, start, end) || (name.exact !== null && stripped(text.slice(start, end)) !== name.exact);
      found.push({ start, end, name, held });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let reach = 0;
  for (const s of found) {
    if (s.start < reach) continue;
    kept.push(s);
    reach = s.end;
  }
  return kept;
}

/**
 * A page's texts in reading order, each split into runs. Each target links at its first mention on the
 * page, and a text links at most `perText` names; a mention it has no room for stays plain. A web address
 * in the text is one link, shown short (addresses.ts): a name inside it ("Z.ai" in https://Z.ai) is part of
 * the address, not a mention.
 */
export function linkMentions(texts: ReadonlyArray<string | null | undefined>, targets: readonly MentionTarget[], perText = 3): MentionRun[][] {
  const names = namesOf(targets);
  const linked = new Set<string>();
  return texts.map((text) => {
    if (!text) return [];
    const marks: Array<{ start: number; end: number; run: MentionRun }> = [];
    for (const { at, url } of bareAddresses(text)) marks.push({ start: at, end: at + url.length, run: { text: shownAddress(url), href: url } });
    const inAddress = (s: Span) => marks.some((m) => s.start < m.end && s.end > m.start);
    let count = 0;
    for (const s of spans(text, names)) {
      const href = s.name.href;
      if (s.held || href === null || linked.has(href) || count >= perText || inAddress(s)) continue;
      marks.push({ start: s.start, end: s.end, run: { text: text.slice(s.start, s.end), href } });
      linked.add(href);
      count++;
    }
    marks.sort((a, b) => a.start - b.start);
    const runs: MentionRun[] = [];
    let at = 0;
    for (const m of marks) {
      if (m.start > at) runs.push(text.slice(at, m.start));
      runs.push(m.run);
      at = m.end;
    }
    if (at < text.length) runs.push(text.slice(at));
    return runs;
  });
}

/**
 * The targets these texts name, in order of first mention, with the names they used. Names that only hold
 * their place are among them, so a page linking with these links as it would with the whole list.
 */
export function mentionedTargets(texts: ReadonlyArray<string | null | undefined>, targets: readonly MentionTarget[]): MentionTarget[] {
  const names = namesOf(targets);
  const found = new Map<string | null, Set<string>>();
  for (const text of texts) {
    if (!text) continue;
    for (const s of spans(text, names)) {
      const used = found.get(s.name.href) ?? new Set<string>();
      used.add(s.name.text);
      found.set(s.name.href, used);
    }
  }
  return [...found].map(([href, used]) => ({ href, names: [...used] }));
}

/** Names that more than one page goes by link to none of them; they stay under no page, holding their place. */
export function withoutSharedNames(targets: readonly MentionTarget[]): MentionTarget[] {
  const owners = new Map<string, Set<string | null>>();
  for (const t of targets) {
    for (const name of t.names) {
      const key = skeleton(name).text;
      const set = owners.get(key) ?? new Set<string | null>();
      set.add(t.href);
      owners.set(key, set);
    }
  }
  const sole = (name: string) => owners.get(skeleton(name).text)?.size === 1;
  const shared = [...new Set(targets.flatMap((t) => t.names.filter((name) => !sole(name))))];
  return [
    ...targets.map((t) => ({ href: t.href, names: [...new Set(t.names)].filter(sole) })).filter((t) => t.names.length > 0),
    ...(shared.length > 0 ? [{ href: null, names: shared }] : []),
  ];
}
