// RSS 2.0 / Atom / RDF feeds.
import { XMLParser } from "fast-xml-parser";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  // XHTML is mixed content: keep its markup and text order for stripTags/sanitizeBody below.
  // Only XHTML stops parsing; escaped HTML and CDATA retain their existing entity handling.
  stopNodes: ["feed.entry.title[type=xhtml]", "feed.entry.summary[type=xhtml]", "feed.entry.content[type=xhtml]"],
});

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#cdata" in o) return text(o["#cdata"]);
    if ("#text" in o) return text(o["#text"]);
  }
  return "";
}

function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseDate(v: string): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isFinite(t)) return new Date(t);
  // RFC 822 variants with Chinese weekday or odd zones
  const cleaned = v.replace(/星期[一二三四五六日天]/, "").replace(/\s+/g, " ").trim();
  const t2 = Date.parse(cleaned);
  return Number.isFinite(t2) ? new Date(t2) : null;
}

function atomLink(links: unknown, base: string): string {
  const list = arr(links as Record<string, string> | Array<Record<string, string>>);
  const alt = list.find((l) => typeof l === "object" && (!l["@rel"] || l["@rel"] === "alternate"));
  const link = alt ?? list[0];
  const href = typeof link === "string" ? link : link?.["@href"];
  if (!href) return "";
  const linkBase = typeof link === "object" ? new URL(link["@xml:base"] ?? "", base).toString() : base;
  return new URL(href, linkBase).toString();
}

function imagesFrom(html: string, base: string): Array<{ kind: "image"; url: string }> {
  const out: Array<{ kind: "image"; url: string }> = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
    try {
      out.push({ kind: "image", url: new URL(m[1]!, base).toString() });
    } catch {
      // ignore bad urls
    }
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Feed text of an editorial source that only teases the article: short and ending in a "read more"
 * mark (The Verge's "Read the full story at The Verge."). Treated as a summary, so extraction fetches
 * the page before the article is judged.
 */
const TEASER_BELOW = 1200;
const TEASER_MARKS = [
  /\bappeared first on\b/i,
  /\bread (?:the )?full (?:story|article)\b/i,
  /\bcontinue reading\b/i,
  /\bread more\b/i,
  /…\s*$/,
  /\[\s*(?:…|\.\.\.)\s*\]\s*$/,
];

export function isTeaser(text: string): boolean {
  const t = text.trim();
  return t.length < TEASER_BELOW && TEASER_MARKS.some((m) => m.test(t));
}

/**
 * The body and excerpt of a feed entry: its text when it is the article, else no body (a summary, or
 * a teaser that stands in as the excerpt when the entry has none).
 */
function feedText(bodyHtml: string | null, summaryHtml: string, source: SourceRow): Pick<Candidate, "excerpt" | "bodyHtml" | "bodyText" | "bodyStatus"> {
  const bodyText = bodyHtml ? stripTags(bodyHtml) : null;
  const teaser = !!bodyText && source.participation_mode === "editorial" && isTeaser(bodyText);
  const excerpt = summaryHtml ? collapseWhitespace(stripTags(summaryHtml)).slice(0, 2000) : teaser ? collapseWhitespace(bodyText!) : null;
  return bodyText && bodyText.length > 280 && !teaser
    ? { excerpt, bodyHtml, bodyText, bodyStatus: "ok" }
    : { excerpt, bodyHtml: null, bodyText: null, bodyStatus: "pending" };
}

interface RssValidator {
  configHash: string;
  responseUrl: string;
  etag: string | null;
  lastModified: string | null;
}

export interface RssRead {
  candidates: Candidate[];
  validator: RssValidator;
  notModified: boolean;
}

export async function fetchRss(source: SourceRow, opts: { force?: boolean } = {}): Promise<RssRead> {
  const url = String(source.config.feedUrl ?? "");
  if (!url) throw new FetchError("feedUrl missing");
  // Config changes can alter parsing/filtering even when the upstream bytes did not change.
  const configHash = sha256(stableJson(source.config));
  const previous = !opts.force && source.cursor?.rss?.configHash === configHash ? source.cursor.rss as RssValidator : null;
  const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" };
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  let res = await guardedFetch(url, { headers, timeoutMs: 25_000 });
  // A redirect may have changed destinations, whose ETag namespace is unrelated to the old one.
  if (res.status === 304 && previous && res.url !== previous.responseUrl) {
    res = await guardedFetch(url, { headers: { accept: headers.accept! }, timeoutMs: 25_000 });
  }
  const validator: RssValidator = {
    configHash, responseUrl: res.url,
    etag: res.headers.get("etag") ?? (res.status === 304 ? previous?.etag ?? null : null),
    lastModified: res.headers.get("last-modified") ?? (res.status === 304 ? previous?.lastModified ?? null : null),
  };
  if (res.status === 304 && previous && (previous.etag || previous.lastModified) && res.url === previous.responseUrl) {
    return { candidates: [], validator, notModified: true };
  }
  if (res.status !== 200) throw new FetchError(`HTTP ${res.status}`, res.status);
  let doc: Record<string, any>;
  try {
    doc = parser.parse(res.text());
  } catch (e) {
    throw new FetchError(`feed parse error: ${String(e).slice(0, 200)}`);
  }
  const summaryIsBody = source.config.summaryIsBody === true;
  // Entries that are sections of one page (#september-24-2026 …) keep their fragment as identity.
  const identity = (link: string) =>
    source.config.preserveUrlFragment === true ? { identityKey: identityKeyForUrl(link, { keepFragment: true }) ?? undefined } : {};
  const out: Candidate[] = [];

  const channel = doc.rss?.channel ?? doc["rdf:RDF"];
  if (channel) {
    const items = arr(doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item);
    for (const it of items) {
      const guid = text(it.guid);
      const enclosures = arr(it.enclosure as Record<string, string> | Array<Record<string, string>>);
      const page = text(it.link) || (/^https?:\/\//i.test(guid) ? guid : "");
      // Podcast episodes often have no <link> and a guid that is not an address: readers get the episode's
      // media file instead. The identity stays the one the guid gives (as in identityKeyFor), so episodes
      // already stored are not collected again, and a host moving its media files creates no new items.
      const mediaFile = page ? "" : enclosures.find((e) => /^(audio|video)\//.test(e?.["@type"] ?? ""))?.["@url"] ?? "";
      const link = page || mediaFile || guid;
      const title = collapseWhitespace(stripTags(text(it.title)));
      if (!link || !title) continue;
      const contentEncoded = text(it["content:encoded"]);
      const description = text(it.description);
      const bodyHtmlRaw = contentEncoded || (summaryIsBody ? description : "");
      const bodyHtml = bodyHtmlRaw ? sanitizeBody(bodyHtmlRaw, link) : null;
      const enclosure = enclosures.find((e) => /^image\//.test(e?.["@type"] ?? ""));
      const media = [
        ...(enclosure ? [{ kind: "image" as const, url: enclosure["@url"]! }] : []),
        ...(bodyHtmlRaw ? imagesFrom(bodyHtmlRaw, link) : []),
      ];
      out.push({
        url: link,
        ...(mediaFile && guid ? { identityKey: `src:${source.id}:${sha256(guid + "\u0001" + title).slice(0, 32)}` } : identity(link)),
        title,
        author: text(it["dc:creator"]) || text(it.author) || null,
        publishedAt: parseDate(text(it.pubDate) || text(it["dc:date"]) || text(it.published)),
        ...feedText(bodyHtml, description, source),
        media: media.slice(0, 6),
        categories: arr(it.category).map((c) => text(c)).filter(Boolean),
        raw: { guid: text(it.guid) || null },
      });
    }
    return { candidates: out, validator, notModified: false };
  }

  const feed = doc.feed;
  if (feed) {
    // XML Base is inherited; redirects determine the document's base, not the configured URL.
    const feedBase = new URL(feed["@xml:base"] ?? "", res.url).toString();
    for (const e of arr(feed.entry)) {
      const entryBase = new URL(e["@xml:base"] ?? "", feedBase).toString();
      const entryUrl = atomLink(e.link, entryBase);
      const title = collapseWhitespace(stripTags(text(e.title)));
      if (!entryUrl || !title) continue;
      const content = text(e.content);
      const summary = text(e.summary);
      const bodyHtml = content ? sanitizeBody(content, entryUrl) : null;
      out.push({
        url: entryUrl,
        ...identity(entryUrl),
        title,
        author: text(arr(e.author)[0]?.name) || null,
        publishedAt: parseDate(text(e.published) || text(e.updated)),
        sourceUpdatedAt: parseDate(text(e.updated)),
        ...feedText(bodyHtml, summary, source),
        media: content ? imagesFrom(content, entryUrl) : [],
        categories: arr(e.category).map((c: any) => c?.["@term"] ?? text(c)).filter(Boolean),
        raw: { id: text(e.id) || null },
      });
    }
    return { candidates: out, validator, notModified: false };
  }
  throw new FetchError("not an RSS/Atom document");
}
