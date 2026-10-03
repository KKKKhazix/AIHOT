// Web list pages: HTML with selectors, Markdown through Jina Reader, and Docusaurus changelogs.
import * as cheerio from "cheerio";
import { guardedFetch } from "../lib/http-fetch.ts";
import { normalizeUrl } from "../lib/url.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { readable, type ExtractedBody } from "../content/extract.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { jinaRead } from "../providers/jina.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

const JINA_PREFIX = "https://r.jina.ai/";

/** A time followed by its zone: "10:00Z", "10:00:00+08:00", "10:00:00 +0000", "10:00:00 GMT". */
const EXPLICIT_ZONE = /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\b/i;

function atOffset(y: string | number, mo: string | number, d: string | number, h: string | number, mi: string | number, s: string | number, utcOffset: string): Date | null {
  const p = (n: string | number) => String(n).padStart(2, "0");
  const t = Date.parse(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}${utcOffset}`);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * A published date as a list page or article prints it. Date.parse is kept only where it reads the same
 * on every host: a time with its zone, and an ISO date alone (UTC midnight). Anything else it would read
 * in the server's local zone (UTC in Docker), so "2026-09-26 10:00" is read in the source's offset instead.
 */
export function parseLooseDate(value: string | null | undefined, utcOffset = "+08:00"): Date | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (EXPLICIT_ZONE.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const direct = Date.parse(v);
    if (Number.isFinite(direct) && /\d{4}/.test(v)) return new Date(direct);
  }
  // 2026-09-26 / 2026/09/26 / 2026-09-26T10:00 / 2026年9月26日 (+ optional time), interpreted in the given offset.
  const m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:(?:T|\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
    return atOffset(y!, mo!, d!, h, mi, s, utcOffset);
  }
  // "Sep 26, 2026": Date.parse reads it in the host's zone, so take its fields and place them in the offset.
  const en = Date.parse(v.replace(/(\d)(st|nd|rd|th)/, "$1"));
  if (!Number.isFinite(en)) return null;
  const local = new Date(en);
  return atOffset(local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), utcOffset);
}

/** The datePublished of the page's structured data (JSON-LD, also inside @graph or embedded app state). */
export function jsonLdPublished($: cheerio.CheerioAPI, html: string): string | null {
  const find = (v: unknown, depth = 0): string | null => {
    if (depth > 6 || v === null || typeof v !== "object") return null;
    if (Array.isArray(v)) {
      for (const x of v) {
        const got = find(x, depth + 1);
        if (got) return got;
      }
      return null;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.datePublished === "string" && o.datePublished) return o.datePublished;
    return find(o["@graph"], depth + 1);
  };
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const got = find(JSON.parse($(el).text()));
      if (got) return got;
    } catch {
      // a broken block: the pattern below may still find it
    }
  }
  return /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? null;
}

/** Prefix rules ignore the scheme: a Jina listing of an http:// address links its posts over http. */
const overHttps = (url: string) => url.replace(/^http:\/\//i, "https://");

export function allowed(url: string, source: SourceRow): boolean {
  const allow: string[] = (source.config.allowUrlPrefixes ?? []).map(overHttps);
  const deny: string[] = (source.config.denyUrlPrefixes ?? []).map(overHttps);
  const target = overHttps(url);
  if (deny.some((p) => target.startsWith(p))) return false;
  return allow.length === 0 || allow.some((p) => target.startsWith(p));
}

/** Query keys that page or filter a listing. Other keys name a post (WordPress /?p=123). */
const LISTING_PARAMS = /^(page|paged|cat|category|categories|tag|tags|label|labels|author|authors)$/i;

/** A link back to the listing page itself (skip links, in-page anchors such as #paper, #blog, ?page=2). */
function listingItself(url: string, listing: string): boolean {
  const bare = (s: string) => {
    const x = new URL(s);
    const query = new URL(normalizeUrl(s) ?? s).searchParams;
    for (const key of [...query.keys()]) if (LISTING_PARAMS.test(key)) query.delete(key);
    return `${x.host}${x.pathname.replace(/\/$/, "")}?${query}`;
  };
  return bare(url) === bare(listing);
}

/**
 * Navigation a listing links to but that is no post: the listing itself, year archives, and taxonomy,
 * author and pagination pages.
 */
function navigationLink(url: string, listing: string): boolean {
  if (listingItself(url, listing)) return true;
  const u = new URL(url);
  return /\/(label|labels|tag|tags|category|categories|author|authors|page)(\/|$)/i.test(u.pathname) || /\/(19|20)\d{2}(\/\d{1,2})?\/?$/.test(u.pathname);
}

/** Absolute http(s) URL; a link to the listing's own https site keeps https. */
function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const b = new URL(base);
    if (u.protocol === "http:" && b.protocol === "https:" && u.host === b.host) u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchListingText(source: SourceRow): Promise<{ text: string; viaJina: boolean; base: string }> {
  const url = String(source.config.url ?? "");
  if (!url) throw new FetchError("url missing");
  if (url.startsWith(JINA_PREFIX)) {
    const target = url.slice(JINA_PREFIX.length);
    // A listing parsed with selectors asks Jina for the rendered HTML (a site our resolver cannot reach
    // still gets its dates and titles from the markup); otherwise Jina's Markdown.
    const format = source.config.parseMode === "html" ? "html" : undefined;
    const page = await jinaRead(target, { purpose: "source_listing", subject: `source:${source.id}`, cacheToleranceSeconds: source.config.cacheToleranceSeconds, format, perRead: true });
    return { text: page.markdown, viaJina: true, base: source.config.baseUrl ?? target };
  }
  const res = await guardedFetch(url, { headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" }, timeoutMs: 25_000 });
  if (res.status !== 200) throw new FetchError(`HTTP ${res.status}`, res.status);
  return { text: res.text(), viaJina: false, base: source.config.baseUrl ?? url };
}

export function fromMarkdown(md: string, base: string, source: SourceRow): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const listing = String(source.config.url ?? base).replace(JINA_PREFIX, "");
  // Card links wrap an image and the text, [![alt](img) ##### Title …](url "Title"): images go first so the
  // link text is plain; a bare image link is then left without a title and skipped, as are nav-length labels.
  const text = md.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Listings whose teasers link other articles in their prose (Axios: "capping a [chaotic three weeks](…)")
  // take only links that begin their line, after heading, list, quote or emphasis marks and image links.
  const startsLine = (at: number) =>
    /^[\s>#*+_|-]*(?:\d+[.)]\s*)?[\s*_]*$/.test(text.slice(text.lastIndexOf("\n", at - 1) + 1, at).replace(/\[\]\([^)]*\)/g, ""));
  for (const m of text.matchAll(/\[([^\]]{6,1000})\]\((https?:\/\/[^)\s]+|\/[^)\s]*)(?:\s+"([^"]*)")?\)/g)) {
    const url = absolute(m[2], base);
    if (!url || seen.has(url) || !allowed(url, source)) continue;
    const section = source.config.preserveUrlFragment === true && new URL(url).hash.length > 1 && listingItself(url, listing);
    if (!section && navigationLink(url, listing)) continue;
    if (source.config.linksStartLine === true && !startsLine(m.index!)) continue;
    const label = collapseWhitespace(m[1]!.replace(/[*_`#]/g, ""));
    // A title attribute the card text already contains is the clean title, without dates and blurbs.
    const attr = collapseWhitespace(m[3] ?? "");
    const title = attr.length >= 6 && label.includes(attr) ? attr : label;
    if (title.length < 6) continue;
    seen.add(url);
    out.push({ url, title });
  }
  return out;
}

export function fromHtml(html: string, base: string, source: SourceRow): Candidate[] {
  const c = source.config;
  const $ = cheerio.load(html);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const listing = String(c.url ?? base).replace(JINA_PREFIX, "");
  // Sections of the listing page are posts only for sources that keep fragments as identity.
  const sectionsArePosts = c.preserveUrlFragment === true;
  const itemSel: string | undefined = c.itemSelector;
  const nodes = itemSel ? $(itemSel).toArray() : $("a[href]").toArray();
  for (const node of nodes) {
    const el = $(node);
    const linkEl = c.linkSelector ? (el.is(c.linkSelector) ? el : el.find(c.linkSelector).first()) : el.is("a") ? el : el.find("a[href]").first();
    const url = absolute(linkEl.attr("href"), base);
    if (!url || seen.has(url) || !allowed(url, source)) continue;
    if (!sectionsArePosts && listingItself(url, listing)) continue;
    const titleEl = c.titleSelector ? (el.is(c.titleSelector) ? el : el.find(c.titleSelector).first()) : linkEl;
    const title = collapseWhitespace(titleEl.text() || linkEl.attr("title") || "");
    if (!title) continue;
    let publishedAt: Date | null = null;
    if (c.publishedAtSelector) {
      const dateEl = el.find(c.publishedAtSelector).first();
      publishedAt = parseLooseDate(dateEl.attr("datetime") ?? dateEl.attr("title") ?? dateEl.text(), c.publishedAtUtcOffset);
    }
    if (!publishedAt && c.publishedAtRegex) {
      const m = new RegExp(c.publishedAtRegex).exec($.html(el));
      publishedAt = parseLooseDate(m?.[1], c.publishedAtUtcOffset);
    }
    seen.add(url);
    out.push({ url, title, publishedAt });
  }
  return out;
}

/** A changelog heading that is only a date, bare or after a short label: "时间: 2026-09-10", "时间：2024-05-17". */
const DATE_HEADING = /^(?:[^\d:：]{1,12}[:：])?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/;

/** The day a date heading names, at midnight in the source's offset (Date.parse would read "时间: …" in the host's zone). */
function headingDate(title: string, utcOffset = "+08:00"): Date | null | undefined {
  const m = DATE_HEADING.exec(title);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}T00:00:00${utcOffset}`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function fromDocusaurusChangelog(html: string, base: string, source: SourceRow): Candidate[] {
  const $ = cheerio.load(html);
  const out: Candidate[] = [];
  // A date heading is no update itself: it dates the updates under it, up to the next h2.
  let sectionDate: Date | null = null;
  $("article h2[id], article h3[id], .markdown h2[id], .markdown h3[id]").each((_i, h) => {
    const head = $(h);
    const id = head.attr("id")!;
    const title = collapseWhitespace(head.text().replace(/​/g, "").replace(/#$/, ""));
    const date = headingDate(title, source.config.publishedAtUtcOffset);
    if (date !== undefined) {
      sectionDate = date;
      return;
    }
    if (head.is("h2")) sectionDate = null;
    const parts: string[] = [];
    let n = head.next();
    while (n.length && !n.is("h2, h3")) {
      parts.push($.html(n));
      n = n.next();
    }
    const bodyHtml = sanitizeBody(parts.join(""), base);
    const url = `${base.replace(/#.*$/, "")}#${id}`;
    if (!allowed(url.replace(/#.*$/, ""), source)) return;
    out.push({
      url,
      identityKey: `url:${url}`,
      title,
      publishedAt: parseLooseDate(title) ?? sectionDate ?? parseLooseDate(stripTags(bodyHtml).slice(0, 80)),
      bodyHtml,
      bodyText: stripTags(bodyHtml),
      bodyStatus: "ok",
    });
  });
  return out;
}

async function fetchScript(url: string): Promise<string> {
  const res = await guardedFetch(url, { timeoutMs: 25_000 });
  if (res.status !== 200) throw new FetchError(`HTTP ${res.status} for ${url}`, res.status);
  return res.text();
}

/** A double-quoted string literal in minified script. */
const SCRIPT_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
function scriptString(literal: string): string {
  try {
    return JSON.parse(literal.replace(/\\x([0-9a-f]{2})/gi, "\\u00$1").replace(/\\'/g, "'"));
  } catch {
    return literal.slice(1, -1);
  }
}

/**
 * mimo.xiaomi.com (config.adapter "mimo_home"). The homepage's post rows navigate by script: its HTML has
 * their titles but no links, so the generic parse found only the menu (MiMo Desktop, 简体中文, #paper).
 * The rows are a prop of the homepage's own chunk, `sectionTitle:"Blog", … blogs:[{title:"…",
 * link:"/blog/…", desc:"…"}, …]`; the site's route table names the chunks of path "/" and the runtime's
 * chunk map their files, both in the scripts the homepage loads. A homepage that no longer looks like
 * this fails the fetch instead of falling back to the menu.
 */
async function fromMimoHome(html: string, base: string, source: SourceRow): Promise<Candidate[]> {
  let routeChunks: string[] = [];
  let chunkFile: ((id: string) => string | null) | null = null;
  // Entry scripts come last; the libraries loaded before them hold neither table.
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => absolute(m[1], base)).filter((u) => u !== null);
  for (const src of scripts.reverse()) {
    if (routeChunks.length && chunkFile) break;
    const js = await fetchScript(src);
    const route = /\{path:"\/",[^{}]*\}/.exec(js)?.[0];
    if (route) routeChunks = [...route.matchAll(/\.e\("([^"]+)"\)/g)].map((m) => m[1]!);
    const map = /"(static\/js\/async\/)"\+\w+\+"\."\+\(?\{([^}]*)\}\)?\[\w+\]\+"\.js"/.exec(js);
    const publicPath = /\b\w+\.p="([^"]*)"/.exec(js)?.[1];
    if (map && publicPath !== undefined) {
      const names = new Map([...map[2]!.matchAll(/"?(\w+)"?:"(\w+)"/g)].map((m) => [m[1]!, m[2]!]));
      const root = new URL(publicPath, src);
      chunkFile = (id) => (names.has(id) ? new URL(`${map[1]}${id}.${names.get(id)}.js`, root).toString() : null);
    }
  }
  if (!routeChunks.length || !chunkFile) throw new FetchError("mimo_home: no route table or chunk map in the homepage scripts");
  const listing = String(source.config.url ?? base);
  // The page's own chunk is the last one its route loads.
  for (const id of routeChunks.reverse()) {
    const file = chunkFile(id);
    if (!file) continue;
    const js = await fetchScript(file);
    const at = js.indexOf('sectionTitle:"Blog"');
    if (at < 0) continue;
    const next = js.indexOf("sectionTitle:", at + 1);
    const section = js.slice(at, next < 0 ? undefined : next);
    const out: Candidate[] = [];
    for (const [row] of section.matchAll(new RegExp(String.raw`\{(?:[^{}"]|${SCRIPT_STRING})*\}`, "g"))) {
      const field = (name: string) => {
        const m = new RegExp(String.raw`\b${name}:(${SCRIPT_STRING})`).exec(row);
        return m ? collapseWhitespace(scriptString(m[1]!)) : "";
      };
      const url = absolute(field("link"), base);
      const title = field("title");
      if (!url || !title || out.some((c) => c.url === url) || !allowed(url, source) || listingItself(url, listing)) continue;
      const desc = field("desc");
      out.push({ url, title, excerpt: desc && desc !== title ? desc : null });
    }
    return out;
  }
  throw new FetchError("mimo_home: no Blog list in the homepage's chunks");
}

export async function fetchWebList(source: SourceRow): Promise<Candidate[]> {
  const { text, viaJina, base } = await fetchListingText(source);
  const mode = source.config.adapter === "mimo_home" ? "mimo_home" : source.config.parseMode ?? (viaJina ? "markdown" : "html");
  let out: Candidate[];
  if (mode === "mimo_home") out = await fromMimoHome(text, base, source);
  else if (mode === "markdown") out = fromMarkdown(text, base, source);
  else if (mode === "docusaurus_changelog") out = fromDocusaurusChangelog(text, base, source);
  else out = fromHtml(text, base, source);
  if (out.length === 0) throw new FetchError(`no items matched (${mode})`);
  return out;
}

export interface DetailNeed {
  date: boolean;
  title: boolean;
  summary: boolean;
  /** Reuse HTML already needed for metadata; never fetch a page just for this hint. */
  body?: boolean;
}

/**
 * What a listing's detail pages add (config.detail): the date, title and summary its rules find. Each
 * rule reads the rendering it was written for. For a listing read through Jina, regexes match Jina's
 * text ("Published Time: …", "# Heading"), so that paid rendering is bought only when such a rule is
 * needed; selectors and page metadata read the page's own HTML.
 */
export async function fetchDetail(url: string, source: SourceRow, need: DetailNeed): Promise<{ publishedAt: Date | null; title: string | null; summary: string | null; body: ExtractedBody | null }> {
  const d = source.config.detail ?? {};
  const jinaListing = String(source.config.url ?? "").startsWith(JINA_PREFIX);
  const dateInJina = need.date && jinaListing && !!d.publishedAtRegex;
  const titleInJina = need.title && jinaListing && !!d.titleRegex;
  const jina = dateInJina || titleInJina ? (await jinaRead(url, { purpose: "source_detail", subject: `source:${source.id}` })).raw : null;
  let html: string | null = null;
  let body: ExtractedBody | null = null;
  if ((need.date && !dateInJina) || (need.title && !titleInJina) || need.summary) {
    const res = await guardedFetch(url, { timeoutMs: 20_000 });
    if (res.status === 200) {
      html = res.text();
      if (need.body && /html/.test(res.headers.get("content-type") ?? "")) {
        try { body = readable(html, res.url); }
        catch { /* A failed extraction must not discard the detail metadata. */ }
      }
    }
  }
  const $ = html === null ? null : cheerio.load(html);

  let publishedAt: Date | null = null;
  const dateText = dateInJina ? jina : html;
  if (need.date && dateText !== null) {
    if ($ && !dateInJina && d.publishedAtSelector) {
      const el = $(d.publishedAtSelector).first();
      publishedAt = parseLooseDate(el.attr("datetime") ?? el.attr("title") ?? el.text(), d.publishedAtUtcOffset);
    }
    if (!publishedAt && d.publishedAtRegex) publishedAt = parseLooseDate(new RegExp(d.publishedAtRegex).exec(dateText)?.[1], d.publishedAtUtcOffset);
    // An authoritative rule is the only source of the date: when its byline is missing, no other
    // timestamp on the page (an update time, a related post) stands in for it.
    const authoritative = d.publishedAtAuthoritative === true && !!(d.publishedAtSelector || d.publishedAtRegex);
    if (!publishedAt && $ && !dateInJina && !authoritative) {
      const meta = $('meta[property="article:published_time"], meta[name="pubdate"], meta[itemprop="datePublished"]').attr("content");
      publishedAt = parseLooseDate(meta) ?? parseLooseDate(jsonLdPublished($, html!)) ?? parseLooseDate($("time[datetime]").first().attr("datetime"));
    }
  }

  let title: string | null = null;
  if (need.title) {
    const titleText = titleInJina ? jina : html;
    if (d.titleRegex && titleText !== null) title = collapseWhitespace(new RegExp(d.titleRegex, "m").exec(titleText)?.[1] ?? "") || null;
    else if (d.titleSelector && $) title = collapseWhitespace($(d.titleSelector).first().text()) || null;
  }

  let summary: string | null = null;
  if (need.summary && $) {
    const el = $(d.summarySelector).first();
    summary = collapseWhitespace(el.attr("content") ?? el.text()) || null;
  }
  return { publishedAt, title, summary, body };
}
