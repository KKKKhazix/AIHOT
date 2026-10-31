// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import type { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { guardedFetch, languageHeaders } from "../lib/http-fetch.ts";
import { assertPageContent, contentDocument, UnavailablePageError } from "../lib/page-content.ts";
import { stripTags } from "../lib/text.ts";
import { isVideoPageUrl } from "../lib/video-url.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { articleUtcOffset, readPublicationDate, type PublicationDate } from "../sources/dates.ts";
import type { SourceRow } from "../sources/types.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, fillPublicationTime, reviseMaterial, updatePresentation, type MediaItem } from "./materials.ts";
import { markdownBody } from "./markdown.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina";
  /** The page's publication metadata; neither modification time nor dates mentioned in its prose. */
  publishedAt?: Date | null;
  publicationTime?: string | null;
}

const MIN_BODY_CHARS = 200;

/**
 * Paths that serve a sign-in form rather than the page that was asked for. A path segment, never a
 * substring: "/auth-for-agents" and "/authors/x" are ordinary pages.
 */
// Sign-in paths read from the final address, never the text. login|log-in|log_in|signin|sign-in|sign_in|
// register|signup|sign-up|sign_up cover the naming schemes sites use (Devise's /users/sign_in among them);
// wp-login.php is WordPress's login page; the extension alternatives read /login.php, /register.html —
// a segment only counts when it ends at a delimiter (a real page path or an extension), so a page that
// merely carries an auth word ("login.company", "sso-products") stays content.
const AUTH_PATH = /(?:^|\/)(?:login|log-in|log_in|signin|sign-in|sign_in|register|signup|sign-up|sign_up|authorize|oauth2?|sso|auth|wp-login(?:\.php)?)(?:\/|$|\.(?:php|aspx?|html?|jsp))/i;

/** Whether an address is a sign-in form's own path (a listing's "Log in" link is no post either). */
export function isSignInUrl(url: string): boolean {
  try {
    return AUTH_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * A redirect that ended on a sign-in form: the site sent us to authenticate instead of to the page.
 * Read from the final address of the fetch, never from the text, so an article that merely mentions
 * signing in is untouched — a real one (a news piece about password autofill) reads like a login
 * page to any text test.
 *
 * The real case: a source built arxiv.org URLs and HuggingFace answered with its login page. The
 * sign-in form passed the length test and became the body, its navigation differed between fetches so
 * every fetch looked like a new revision of the article (one reached 26 revisions), and the article
 * entered the pool under a title of "220".
 */
export function isSignInRedirect(asked: string, landed: string): boolean {
  try {
    // An address already on such a path was not sent anywhere: a registry page at ".../register" that
    // only gained a trailing slash is still the page that was asked for.
    return !AUTH_PATH.test(new URL(asked).pathname) && AUTH_PATH.test(new URL(landed).pathname);
  } catch {
    return false;
  }
}

/** Restore only completed React streaming boundaries, without evaluating any page script. */
function settleStreamedContent(document: ReturnType<typeof parseHTML>["document"]) {
  for (const script of document.querySelectorAll("script:not([src])")) {
    const type = script.getAttribute("type")?.toLowerCase();
    if (type && type !== "text/javascript" && type !== "application/javascript") continue;
    const text = script.textContent ?? "";
    // React emits a standalone completion call, or appends it to its runtime definition. Do not
    // interpret occurrences inside data, comments, documentation strings or arbitrary programs.
    const call = /\$RC\("(B:[\w:.-]+)","(S:[\w:.-]+)"\)\s*;?\s*$/.exec(text);
    if (!call) continue;
    const before = text.slice(0, call.index).trim();
    if (before && !(/^\$R[BCV]=/.test(before) && before.includes("$RC=function(") && before.endsWith("};"))) continue;
    const boundary = document.getElementById(call[1]!);
    const segment = document.getElementById(call[2]!);
    const start = boundary?.previousSibling;
    const parent = boundary?.parentNode;
    if (!boundary || boundary.localName !== "template" || !segment?.hasAttribute("hidden") || !parent
      || !start || start.nodeType !== 8 || !["$?", "$~"].includes(start.textContent ?? "") || segment.contains(boundary)) continue;
    let end = boundary.nextSibling;
    let depth = 0;
    while (end) {
      if (end.nodeType === 8) {
        const marker = end.textContent;
        if (marker === "/$") {
          if (depth === 0) break;
          depth -= 1;
        } else if (["$", "$?", "$!", "$~"].includes(marker ?? "")) depth += 1;
      }
      end = end.nextSibling;
    }
    if (!end) continue;
    let fallback = boundary.nextSibling;
    parent.removeChild(boundary);
    while (fallback && fallback !== end) {
      const next = fallback.nextSibling;
      parent.removeChild(fallback);
      fallback = next;
    }
    while (segment.firstChild) parent.insertBefore(segment.firstChild, end);
    segment.remove();
    start.textContent = "$";
  }
}

/**
 * Readability leaves out what an inline style hides, but compares style.display and style.visibility
 * literally, and linkedom keeps the author's case and "!important" in them. A style that sets either is
 * reduced to what a browser applies: names and keywords in any case, an important declaration over a
 * later plain one, else the last. The nodes stay in place: Readability restores noscript images beside
 * their hidden placeholders, and drops every style from the body afterwards.
 */
function settleInlineVisibility(document: ReturnType<typeof parseHTML>["document"]) {
  for (const el of document.querySelectorAll("[style]")) {
    const style = el.getAttribute("style") ?? "";
    if (!/display|visibility/i.test(style)) continue;
    const applied = new Map<string, { value: string; important: boolean }>();
    for (const declaration of style.split(";")) {
      const colon = declaration.indexOf(":");
      const name = declaration.slice(0, colon).trim().toLowerCase();
      if (colon < 0 || (name !== "display" && name !== "visibility")) continue;
      const raw = declaration.slice(colon + 1).trim().toLowerCase();
      const important = /!\s*important$/.test(raw);
      const value = raw.replace(/!\s*important$/, "").trim();
      if (value && (important || !applied.get(name)?.important)) applied.set(name, { value, important });
    }
    el.setAttribute("style", [...applied].map(([name, { value }]) => `${name}:${value}`).join(";"));
  }
}

/** An article widget whose meaning lives in its markup, declared by its source (config.detail.preserve). */
export interface PreserveRule {
  selector: string;
  as: "pre" | "table";
  /** pre: the part holding the text (default: the whole widget), and a label to keep above it. */
  code?: string;
  caption?: string;
}

/** How a source's article pages are read: the zone of a time printed without one, the widgets to preserve, and the language asked for. */
export interface PageRules {
  utcOffset?: string;
  preserve?: PreserveRule[];
  acceptLanguage?: string;
}

export const pageRules = (config: SourceRow["config"]): PageRules =>
  ({ utcOffset: articleUtcOffset(config), preserve: config.detail?.preserve, acceptLanguage: config.acceptLanguage });

type Doc = ReturnType<typeof parseHTML>["document"];
type El = NonNullable<ReturnType<Doc["querySelector"]>>;

/** Text of an element as a reader sees it: without scripts, styles and parts hidden from assistive technology. */
function shownText(el: El): string {
  const copy = el.cloneNode(true) as El;
  for (const hidden of copy.querySelectorAll('script, style, [aria-hidden="true"]')) hidden.remove();
  return copy.textContent?.trim() ?? "";
}

/** The widget's text (its `code` part) as a code block, verbatim, under its caption when it has one. */
function codeBlock(document: Doc, el: El, rule: PreserveRule): El | null {
  const text = rule.code ? el.querySelector(rule.code) : el;
  if (!text) return null;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = shownText(text);
  pre.append(code);
  const label = rule.caption ? el.querySelector(rule.caption) : null;
  const caption = label ? shownText(label) : "";
  if (!caption) return pre;
  const block = document.createElement("div");
  const p = document.createElement("p");
  p.textContent = caption;
  block.append(p, pre);
  return block;
}

/**
 * Side-by-side description lists as one table: each child of the element is a column, headed by its
 * first other element with text; their terms are the rows. Null unless every column lists the same terms.
 */
function descriptionTable(document: Doc, el: El): El | null {
  const columns = [...el.children].map(column => {
    const list = column.querySelector("dl");
    const heading = [...column.children].find(child => child !== list && child.getAttribute("aria-hidden") !== "true" && shownText(child));
    return {
      label: heading ? shownText(heading) : "",
      rows: list ? [...list.querySelectorAll("dt")].map(term => ({
        label: shownText(term),
        value: term.nextElementSibling?.localName === "dd" ? shownText(term.nextElementSibling) : "",
      })) : [],
    };
  });
  const rows = columns[0]?.rows;
  if (!rows?.length || columns.some(column => !column.label || column.rows.length !== rows.length
    || column.rows.some((row, i) => !row.label || !row.value || row.label !== rows[i]!.label))) return null;
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  const row = (cells: Array<{ tag: "th" | "td"; text: string }>) => {
    const tr = document.createElement("tr");
    for (const cell of cells) {
      const c = document.createElement(cell.tag);
      c.textContent = cell.text;
      tr.append(c);
    }
    return tr;
  };
  head.append(row(["", ...columns.map(column => column.label)].map(text => ({ tag: "th", text }))));
  rows.forEach((entry, i) => body.append(row([{ tag: "th", text: entry.label },
    ...columns.map(column => ({ tag: "td" as const, text: column.rows[i]!.value }))])));
  table.append(head, body);
  return table;
}

/**
 * A source's declared widgets get a portable structure before Readability removes their controls and
 * CSS: each matched element becomes a code block ("pre") or a table ("table"), keeping what hides it,
 * so a hidden widget stays hidden. One without that shape is left as it is.
 */
function preserveWidgets(document: Doc, rules: PreserveRule[]) {
  for (const rule of rules) {
    for (const el of document.querySelectorAll(rule.selector)) {
      const content = rule.as === "pre" ? codeBlock(document, el, rule) : descriptionTable(document, el);
      if (!content) continue;
      for (const name of ["hidden", "aria-hidden", "style"]) {
        const value = el.getAttribute(name);
        if (value !== null) content.setAttribute(name, value);
      }
      el.replaceWith(content);
    }
  }
}

/** Publication metadata a page names, in order of trust; a modification time is never one of them. */
const PUBLISHED_META = ['meta[property="article:published_time"]', 'meta[name="pubdate"]', 'meta[itemprop="datePublished"]', 'meta[name="parsely-pub-date"]'];

/** The datePublished of the page's structured data (JSON-LD, also inside @graph). */
function structuredPublished(document: Doc): string | null {
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
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const got = find(JSON.parse(el.textContent ?? ""));
      if (got) return got;
    } catch {
      // a broken block names no date
    }
  }
  return null;
}

/**
 * The page's own publication time: its named publication metadata, never a modification time or a date
 * in its prose. The first one found counts; a date without a time gives way to a time the page names
 * for that same day. A time printed without a zone is read in utcOffset (the source's articleUtcOffset).
 */
export function pagePublicationDate(document: Doc, utcOffset?: string): PublicationDate {
  const values = [
    ...PUBLISHED_META.map((selector) => document.querySelector(selector)?.getAttribute("content")),
    structuredPublished(document),
    document.querySelector('time[itemprop~="datePublished"][datetime]')?.getAttribute("datetime"),
  ];
  let day: PublicationDate | null = null;
  for (const value of values) {
    const date = readPublicationDate(value, utcOffset);
    if (!date.publishedAt) continue;
    const timed = date.publicationTime!.includes("T");
    if (!day) {
      if (timed) return date;
      day = date;
    } else if (timed && date.publishedAt.getTime() >= day.publishedAt!.getTime() && date.publishedAt.getTime() - day.publishedAt!.getTime() < 86_400_000) return date;
  }
  return day ?? { publishedAt: null, publicationTime: null };
}

/** The page's article, read under its source's rules (pageRules); null for an error page or no article. */
export function readable(html: string, url: string, rules: PageRules = {}): ExtractedBody | null {
  if (isVideoPageUrl(url)) return null;
  try { return readableDocument(contentDocument(html), url, rules); }
  catch (error) {
    if (error instanceof UnavailablePageError) return null;
    throw error;
  }
}

const collapsed = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** Only letters and digits: "Value: what is it?" and "Value What is it" are the same words. */
const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

/** Hidden by an attribute or an inline style (settleInlineVisibility), itself or inside its figure. */
function hiddenIn(el: El, figure: El): boolean {
  for (let node: El | null = el; node && node !== figure; node = node.parentElement) {
    if (node.hasAttribute("hidden") || /(?:^|;)(?:display:none|visibility:hidden)(?:;|$)/.test(node.getAttribute("style") ?? "")) return true;
  }
  return false;
}

/** A [role="img"] holder that has nothing besides its svgs: no text, image or video of its own. */
function onlyDrawings(holder: El): boolean {
  const copy = holder.cloneNode(true) as El;
  for (const svg of copy.querySelectorAll("svg")) svg.remove();
  return !collapsed(copy.textContent) && !copy.querySelector("img, picture, video");
}

/** The text alternative of a drawing, a line each: what aria-labelledby points to, aria-label, or an svg's title and desc. */
function drawingText(document: Doc, el: El): string[] {
  const ids: string[] = el.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean) ?? [];
  const labelledBy = ids.map(id => collapsed(document.getElementById(id)?.textContent)).filter(Boolean);
  if (labelledBy.length) return labelledBy;
  const label = collapsed(el.getAttribute("aria-label"));
  if (label) return [label];
  if (el.localName !== "svg") return [];
  return ["title", "desc"].map(name => collapsed([...el.children].find(child => child.localName === name)?.textContent)).filter(Boolean);
}

/**
 * An inline SVG drawing in a figure is not kept: its colours come from the page's stylesheet and its
 * labels are not prose. The drawing is the figure's [role="img"] element holding the svg, else the svg;
 * a holder with text or images of its own keeps them, and only its svgs are replaced by its text. The
 * drawing's own text alternative stands in for it as a paragraph, written as text, never as markup. The page
 * hides the drawing from screen readers (aria-hidden) because that text is read instead, so only hidden
 * and style carry over. Wide and narrow versions of one figure give the same text once, from a version
 * that is shown. Words the figure shows (its caption, a heading, not hidden text) are not repeated; a
 * drawing without any text is left to be dropped.
 */
function describeFigureDrawings(document: Doc) {
  const figures = new Map<El, { shown: string; texts: Map<string, El> }>();
  for (const svg of document.querySelectorAll("figure svg")) {
    const figure = svg.closest("figure");
    if (!figure) continue; // inside a drawing already replaced
    const holder = svg.closest('[role="img"]');
    const held = holder && holder !== figure && figure.contains(holder) ? holder : null;
    // The holder describes the drawing; it is replaced whole only when it holds nothing else.
    const drawing = held && onlyDrawings(held) ? held : svg;
    const lines = held ? drawingText(document, held) : [];
    if (!lines.length) lines.push(...drawingText(document, svg));
    const text = lines.join(" ");
    if (!text) continue;
    let seen = figures.get(figure);
    if (!seen) {
      const copy = figure.cloneNode(true) as El;
      // Readability drops aria-hidden elements, so their words are not shown either.
      for (const el of copy.querySelectorAll('svg, [role="img"], [hidden], [style], [aria-hidden="true"]')) {
        if (el.localName === "svg" || (el.getAttribute("role") === "img" && onlyDrawings(el)) || el.getAttribute("aria-hidden") === "true" || hiddenIn(el, copy)) el.remove();
      }
      seen = { shown: words(copy.textContent ?? ""), texts: new Map() };
      figures.set(figure, seen);
    }
    if (seen.shown.includes(words(text))) continue;
    const earlier = seen.texts.get(text);
    if (earlier && (!hiddenIn(earlier, figure) || hiddenIn(drawing, figure))) {
      drawing.remove();
      continue;
    }
    const p = document.createElement("p");
    lines.forEach((line, i) => p.append(...(i ? [document.createElement("br"), line] : [line])));
    for (const name of ["hidden", "style"]) {
      const value = drawing.getAttribute(name);
      if (value !== null) p.setAttribute(name, value);
    }
    drawing.replaceWith(p);
    earlier?.remove();
    seen.texts.set(text, p);
  }
}

/**
 * Readability removes every aside. One set among the article's paragraphs (its parent holds paragraphs of
 * its own) that carries prose, such as an update note or a correction, is part of what the author wrote:
 * it is kept as a quotation. An aside of links, a line with a form, or one beside the article still goes.
 * The quotation keeps the aside's attributes, so a hidden one stays hidden and one named as comments is
 * still judged by that name.
 */
function keepAsidesAmongParagraphs(document: Doc) {
  for (const aside of document.querySelectorAll("aside")) {
    const parent = aside.parentElement;
    if (!parent || ![...parent.children].some((child) => child.localName === "p")) continue;
    if (aside.querySelector("form, input, button")) continue;
    const prose = collapsed([...aside.querySelectorAll("p")].map((p) => p.textContent).join(" "));
    const linked = collapsed([...aside.querySelectorAll("p a")].map((a) => a.textContent).join(" "));
    if (prose.length < 20 || linked.length * 2 > prose.length) continue;
    const quote = document.createElement("blockquote");
    for (const { name, value } of [...aside.attributes]) quote.setAttribute(name, value);
    quote.append(...aside.childNodes);
    aside.replaceWith(quote);
  }
}

/**
 * Readability scores class names, and utility classes that only set overflow, scrolling or snapping read to
 * it as "hidden" or "scroll" ("overflow-hidden", "scroll-mt-24"): a box of the author's text with such a class
 * was dropped. They say nothing about what the box holds, so they are taken off before scoring.
 */
const LAYOUT_CLASS = /^(?:[\w-]+:)*(?:overflow|overscroll|scroll|snap)-[\w-]+$/;
function dropLayoutClasses(document: Doc) {
  for (const el of document.querySelectorAll("[class]")) {
    const classes: string[] = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const kept = classes.filter((c) => !LAYOUT_CLASS.test(c));
    if (kept.length === classes.length) continue;
    if (kept.length) el.setAttribute("class", kept.join(" "));
    else el.removeAttribute("class");
  }
}

/** readable() on a page already parsed and checked (contentDocument). Readability changes the document. */
export function readableDocument(document: Doc, url: string, rules: PageRules = {}): ExtractedBody | null {
  if (isVideoPageUrl(url)) return null;
  const date = pagePublicationDate(document, rules.utcOffset);
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  settleStreamedContent(document);
  settleInlineVisibility(document);
  preserveWidgets(document, rules.preserve ?? []);
  describeFigureDrawings(document);
  keepAsidesAmongParagraphs(document);
  dropLayoutClasses(document);
  // A document theme is not an article candidate: names such as "header-dark" can discard the root.
  document.documentElement.removeAttribute("class");
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(article.content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  try { assertPageContent(article.title ?? "", text); }
  catch (error) {
    if (error instanceof UnavailablePageError) return null;
    throw error;
  }
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability", ...date };
}

export async function extractFromUrl(url: string, subject: string, rules: PageRules = {}, opts: { paidFallback?: boolean } = {}): Promise<ExtractedBody | null> {
  if (isVideoPageUrl(url)) return null;
  try {
    const res = await guardedFetch(url, { headers: languageHeaders(rules.acceptLanguage), timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024 });
    if (isVideoPageUrl(res.url)) return null;
    if (isSignInRedirect(url, res.url)) return null;
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url, rules);
      if (got) return got;
    }
  } catch {
    // fall through to Jina
  }
  if (opts.paidFallback === false) return null;
  try {
    const page = await jinaRead(url, { purpose: "body_fallback", subject });
    const html = markdownBody(page.markdown, url);
    const text = stripTags(html);
    if (text.length < MIN_BODY_CHARS) return null;
    return { html, text, images: [], via: "jina" };
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof UnavailablePageError) return null;
    throw error;
  }
}

/** Ordinary article pages; player pages have no article body, and social posts arrive separately. */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account" || isVideoPageUrl(url)) return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; x_post: { tweetId?: string } | null; config: SourceRow["config"] }[]>`
    SELECT a.id, a.url, a.body_status, a.revision, a.x_post, s.config
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision);
  const got = await extractFromUrl(a.url, `article:${a.id}`, pageRules(a.config));
  if (!got) {
    return markUnconfirmed(articleId, a.revision);
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null; media: MediaItem[] }[]>`
      SELECT title, excerpt, content_hash, media FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const time = a.config.detail?.publishedAtAuthoritative === true ? null : await fillPublicationTime(tx, articleId, got.publishedAt, undefined, got.publicationTime);
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    if (!time && hash === row.content_hash) {
      await updatePresentation(tx, articleId, { html: got.html, media: row.media.length ? row.media : got.images });
      await tx`UPDATE articles SET body_status = 'ok', updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${sql.json(got.images as never)}::jsonb ELSE media END`,
      hash, title: row.title, bodyText: got.text,
    });
    return "ok";
  });
}

async function markUnconfirmed(articleId: string, revision: number): Promise<"unconfirmed" | "skipped"> {
  const rows = await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now()
    WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' RETURNING id`;
  return rows.length ? "unconfirmed" : "skipped";
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; a post that is only the article's link takes the article's title.
 * No article (the link points at someone else's, or X has none) leaves the post "unconfirmed", and
 * the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string, revision: number): Promise<"ok" | "unconfirmed" | "skipped"> {
  const found = await getArticle(tweetId, { purpose: "x_article", subject: `article:${articleId}` });
  const got = found ? xArticleText(found) : null;
  if (!got) {
    return markUnconfirmed(articleId, revision);
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null; x_article: { title?: string | null; text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post, x_article FROM articles
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const block = (a: { title?: string | null; text?: string } | null) => (a ? [a.title ? `# ${a.title}` : "", a.text ?? ""].filter(Boolean).join("\n\n") : "");
    // The post's own text, without an article appended by an earlier extraction (an admin re-run
    // extracts again from the post; appending once more would repeat the article).
    const previous = block(row.x_article);
    let base = row.body_text ?? "";
    if (previous && base.endsWith(previous)) base = base.slice(0, -previous.length).replace(/\s+$/, "");
    const title = got.title && onlyXArticleLink(row.x_post?.text) ? got.title : row.title;
    const bodyText = [base, block(got)].filter(Boolean).join("\n\n");
    if (bodyText === row.body_text && title === row.title) {
      // The same article again: nothing new, no new revision.
      await tx`UPDATE articles SET body_status = 'ok', x_article = ${tx.json(got as never)}, updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`title = ${title}, body_text = ${bodyText}, x_article = ${sql.json(got as never)}, body_status = 'ok'`,
      hash: contentHash({ title, bodyText, excerpt: row.excerpt }), title, bodyText,
    });
    return "ok";
  });
}
