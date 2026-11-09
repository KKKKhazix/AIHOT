// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { DEPLOYMENT } from "@aihot/site";
import { sql } from "../db.ts";
import { guardedFetch, languageHeaders } from "../lib/http-fetch.ts";
import { assertPageContent, contentDocument, UnavailablePageError } from "../lib/page-content.ts";
import { escapeXml, stripTags } from "../lib/text.ts";
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
import { articleCover, declaredCover, hasPicture, type Cover } from "./cover.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina" | "text";
  /** The page's publication metadata; neither modification time nor dates mentioned in its prose. */
  publishedAt?: Date | null;
  publicationTime?: string | null;
  /**
   * The picture the page declares for sharing, for a body without a picture of its own (cover.ts), set above
   * the body where it is shown. A caller that fetched the page checks it against the site's own (articleCover).
   */
  cover?: Cover | null;
}

const MIN_BODY_CHARS = 200;

/**
 * What the browser renderer leaves out of a body it reads: its answer is the whole page, so a site that
 * refuses the direct fetch had its consent dialog, navigation and footer stored and translated as the
 * article. Only what a page itself marks as not being the article: narrowing to main or running
 * Readability over the rendered page lost real text on many sites.
 */
const PAGE_CHROME = "nav,footer,dialog,header:not(article header,main header),[role=banner],[role=navigation],[role=contentinfo],[role=dialog],[role=alertdialog],[aria-modal=true],#onetrust-consent-sdk";

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

/**
 * How a source's article pages are read: the zone of a time printed without one, the widgets to preserve, and the language asked for.
 * Never where the body is: extraction uses one set of rules for every page, and boilerplate that leaks into
 * bodies (subscribe prompts, recommendation blocks) is fixed in those rules rather than per source.
 */
export interface PageRules {
  utcOffset?: string;
  preserve?: PreserveRule[];
  acceptLanguage?: string;
  /** A source's text alternate, such as a commit's .patch; the article keeps its original URL. */
  bodyUrlSuffix?: string;
}

export const pageRules = (config: SourceRow["config"]): PageRules =>
  ({ utcOffset: articleUtcOffset(config), preserve: config.detail?.preserve, acceptLanguage: config.acceptLanguage, bodyUrlSuffix: config.detail?.bodyUrlSuffix });

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

/** Left out by Readability for readers: hidden by an attribute, from assistive technology, or by an inline style. */
function unseen(el: El): boolean {
  return el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true" || /(?:^|;)(?:display:none|visibility:hidden)(?:;|$)/.test(el.getAttribute("style") ?? "");
}

function unseenWithin(el: El, root: El): boolean {
  for (let node: El | null = el; node && node !== root; node = node.parentElement) if (unseen(node)) return true;
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
 * Words a link keeps for screen readers only, under the class names sites give them (sr-only, visually-hidden,
 * screen-reader-text), say what the page shows another way: "(opens in new tab)", a heading anchor's "Link to
 * this section", the dots of a gallery. They were stored and translated as text; readers never see them. They are
 * marked here and taken out of Readability's result, so its judgment of a box by its links is unchanged: cards of
 * other stories and a site's logo carry their names that way. A link to the picture it shows only opens it full
 * size, and its words ("View full-size image: …") go now: counted as link text they made the figure's box read as
 * a box of links (ideogram.ai: every figure set beside its prompt). Outside links, such words can stand for what a
 * body cannot show (a chart's table of values, a drawing's description) and stay.
 */
const SCREEN_READER_ONLY = /^(?!not-)(?:[\w-]+[-_])?(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text|screen-reader-only)$/i;
const SCREEN_READER_MARK = "data-screen-reader-only";
function markScreenReaderLinkText(document: Doc) {
  for (const el of document.querySelectorAll("a [class]")) {
    if (!(el.getAttribute("class") ?? "").split(/\s+/).some((name: string) => SCREEN_READER_ONLY.test(name))) continue;
    const link = el.closest("a")!;
    const href = link.getAttribute("href");
    if (href && [...link.querySelectorAll("img")].some((img) => img.getAttribute("src") === href)) el.remove();
    else el.setAttribute(SCREEN_READER_MARK, "");
  }
}
function withoutScreenReaderLinkText(html: string): string {
  if (!html.includes(SCREEN_READER_MARK)) return html;
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const el of document.querySelectorAll(`[${SCREEN_READER_MARK}]`)) el.remove();
  return document.body.innerHTML;
}

/** An image with an address of its own, not a placeholder: a src that is not empty or a data: URI. */
function addressed(img: El): boolean {
  const src = img.getAttribute("src")?.trim() ?? "";
  return !!src && !/^data:/i.test(src);
}

/** The addresses of an image named by the given attributes (each entry of a srcset), without data: placeholders. */
function addressesIn(el: El, names: string[]): string[] {
  const images = el.localName === "img" ? [el] : [...el.querySelectorAll("img, source")];
  return images.flatMap((img) => names.flatMap((name) => {
    const value = img.getAttribute(name)?.trim() ?? "";
    // A data: URI holds commas of its own; only a srcset lists addresses separated by them.
    return name.endsWith("srcset") ? value.split(",").map((entry: string) => entry.trim().split(/\s+/)[0] ?? "") : [value];
  })).filter((address) => address && !/^data:/i.test(address));
}
/** Every address an image shows, or loads once a script runs. */
const shownAddresses = (el: El) => addressesIn(el, ["src", "data-src", "data-original", "data-lazy-src", "srcset", "data-srcset"]);
/**
 * The address Readability's lazy-image repair writes into an image's src (_fixLazyImages, Readability 0.6), under
 * its own conditions: an SVG base64 src is left alone; a short base64 src beside another image address is dropped
 * first; then only an image without src or srcset, or one whose class says lazy, takes an attribute naming an
 * image file (one naming several with their widths becomes a srcset, which a body does not keep).
 */
function repairedAddress(img: El): string | null {
  const attributes = Array.from(img.attributes as ArrayLike<{ name: string; value: string }>);
  let src = img.getAttribute("src") ?? "";
  const base64 = /^data:\s*([^\s;,]+)\s*;\s*base64\s*,/i.exec(src);
  if (base64) {
    if (base64[1] === "image/svg+xml") return null;
    const elsewhere = attributes.some(({ name, value }) => name !== "src" && /\.(jpg|jpeg|png|webp)/i.test(value));
    if (elsewhere && src.length - base64[0].length < 133) src = "";
  }
  const srcset = img.getAttribute("srcset");
  if ((src || (srcset && srcset !== "null")) && !(img.getAttribute("class") ?? "").toLowerCase().includes("lazy")) return null;
  let repaired: string | null = null;
  for (const { name, value } of attributes) {
    if (name === "src" || name === "srcset" || name === "alt" || /\.(jpg|jpeg|png|webp)\s+\d/.test(value)) continue;
    if (/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/.test(value)) repaired = value.trim();
  }
  return repaired;
}

/**
 * The addresses a stored body keeps for an image: the lazy address sanitizeBody puts in src (data-src,
 * data-original), its src, or the one Readability's lazy-image repair gives it. A srcset is not kept.
 */
function keptAddresses(el: El): string[] {
  const img = el.localName === "img" ? el : el.querySelector("img");
  if (!img) return [];
  const kept = addressesIn(img, ["data-src", "data-original", "src"]);
  if (kept.length) return kept;
  const repaired = repairedAddress(img);
  return repaired ? [repaired] : [];
}

/**
 * Readability puts a noscript picture in its placeholder's place only when the noscript holds a single img right
 * after that placeholder, and removes every other noscript: a picture written with its sources (<picture>), or
 * one written before its lazy placeholder, went with it (allenai.org, wiz.io: every picture of a page). A noscript
 * holding only pictures, one with an address, stands in for its placeholders: the images with no address a body
 * keeps, right before it, else right after it. An image beside it showing the same picture with an address a body
 * keeps is that picture, left to Readability, which keeps one of the two; one that names it only in a srcset is
 * not kept and is a placeholder too.
 */
function showNoscriptPictures(document: Doc) {
  for (const noscript of document.querySelectorAll("noscript")) {
    const held = [...noscript.children];
    if (!held.length || collapsed(noscript.textContent) || held.some((el) => el.localName !== "img" && el.localName !== "picture")) continue;
    if (!held.some((el) => (el.localName === "img" ? [el] : [...el.querySelectorAll("img")]).some(addressed))) continue;
    const own = new Set(held.flatMap(shownAddresses));
    const neighbours = [noscript.previousElementSibling, noscript.nextElementSibling].filter((el): el is El => !!el && (el.localName === "img" || el.localName === "picture"));
    const same = neighbours.filter((el) => shownAddresses(el).some((address) => own.has(address)));
    if (same.some((el) => keptAddresses(el).length)) continue;
    for (const el of same) el.remove();
    const run = (step: (el: El) => El | null) => {
      const found: El[] = [];
      for (let el = step(noscript); el?.localName === "img" && !keptAddresses(el).length; el = step(el)) found.push(el);
      return found;
    };
    const before = run((el) => el.previousElementSibling);
    for (const placeholder of before.length ? before : run((el) => el.nextElementSibling)) placeholder.remove();
    noscript.replaceWith(...noscript.childNodes);
  }
}

/** The words of a button that only says what a click on its picture does. */
const ZOOM_LABEL = /^(?:(?:zoom|in|expand|enlarge|view|open|full|size|image|photo|picture|\d+)\s*)+$/i;

/**
 * Readability removes every button, and a picture the page opens larger on a click sits in one: the button went
 * with its picture (reflection.ai, linear.app, mastra.ai: every picture of a page). A button holding a picture,
 * the only button among its siblings, with no words of its own but such a label, is replaced by its figures,
 * else by the pictures it shows (not a blurred placeholder without an address a body keeps); wide and narrow crops
 * of one picture (the same description) are kept once. A row
 * of picture buttons (tabs, thumbnails to choose from, reactions) and a button that says something are controls.
 */
function unwrapPictureButtons(document: Doc) {
  for (const button of document.querySelectorAll("button")) {
    const parent = button.parentElement;
    if (!parent || unseen(button) || [...parent.children].some((el) => el !== button && el.localName === "button")) continue;
    const outermost = (el: El, name: string) => {
      const outer = el.parentElement?.closest(name);
      return !outer || !button.contains(outer);
    };
    const figures = [...button.querySelectorAll("figure")].filter((figure) => outermost(figure, "figure") && !unseenWithin(figure, button));
    const shown = figures.length ? figures
      : [...button.querySelectorAll("picture, img")].filter((el) => outermost(el, "picture") && !unseenWithin(el, button) && keptAddresses(el).length);
    if (!shown.length) continue;
    const rest = button.cloneNode(true) as El;
    for (const el of rest.querySelectorAll('figure, picture, img, svg, style, script, [aria-hidden="true"]')) el.remove();
    const label = collapsed(rest.textContent);
    if (label && !ZOOM_LABEL.test(label)) continue;
    const descriptions = new Set<string>();
    button.replaceWith(...shown.filter((el) => {
      const description = collapsed((el.localName === "img" ? el : el.querySelector("img"))?.getAttribute("alt"));
      if (!description) return true;
      if (descriptions.has(description)) return false;
      descriptions.add(description);
      return true;
    }));
  }
}

/** The words of an element's class and id: "verge-theme-image__dark" and "darkMode" both have "dark". */
const nameWords = (el: El): string[] => `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`
  .replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);

/**
 * A figure can hold one picture twice, a version for each colour theme of the page, the dark one hidden while the
 * light one shows (theverge.com's charts): kept now that the box around it stays, both showed. Among a figure's
 * sibling pictures with the same description, one named for the dark theme beside one named for the light, shown
 * and with an address a body keeps, is that picture's dark version and goes; a light version the page hides
 * leaves the dark one as the picture. Different pictures can share a description (examples of one class), so a
 * description alone decides nothing.
 */
function dropDarkThemeVersions(document: Doc) {
  for (const figure of document.querySelectorAll("figure")) {
    const groups = new Map<El, Map<string, El[]>>();
    for (const picture of figure.querySelectorAll("img, picture")) {
      const parent = picture.parentElement;
      if (!parent || (picture.localName === "img" && parent.localName === "picture")) continue;
      const description = collapsed((picture.localName === "img" ? picture : picture.querySelector("img"))?.getAttribute("alt"));
      if (!description) continue;
      const byDescription = groups.get(parent) ?? new Map<string, El[]>();
      byDescription.set(description, [...(byDescription.get(description) ?? []), picture]);
      groups.set(parent, byDescription);
    }
    for (const byDescription of groups.values()) {
      for (const versions of byDescription.values()) {
        const named = (word: string) => versions.filter((el) => nameWords(el).includes(word));
        const light = named("light").filter((el) => {
          // Seen from the image that gives the picture its address, a <picture>'s own img included.
          const img = el.localName === "img" ? el : el.querySelector("img");
          return !!img && !unseenWithin(img, figure) && keptAddresses(img).length > 0;
        });
        if (light.length) for (const el of named("dark")) if (!light.includes(el)) el.remove();
      }
    }
  }
}

/**
 * Readability's names and roles for what is beside an article, which remove a box before its content counts
 * (_grabArticle, _getClassWeight).
 */
const READABILITY = Readability.prototype as unknown as {
  REGEXPS: Record<"unlikelyCandidates" | "okMaybeItsACandidate" | "positive" | "negative", RegExp>;
  UNLIKELY_ROLES: string[];
};
const READABILITY_NAMES = READABILITY.REGEXPS;
function namedBeside(el: El): boolean {
  if (READABILITY.UNLIKELY_ROLES.includes(el.getAttribute("role") ?? "")) return true;
  const names = [el.getAttribute("class") ?? "", el.getAttribute("id") ?? ""];
  const both = names.join(" ");
  if (READABILITY_NAMES.unlikelyCandidates.test(both) && !READABILITY_NAMES.okMaybeItsACandidate.test(both)) return true;
  const weight = (name: string) => (READABILITY_NAMES.positive.test(name) ? 25 : 0) - (READABILITY_NAMES.negative.test(name) ? 25 : 0);
  return names.reduce((sum, name) => sum + (name ? weight(name) : 0), 0) < 0;
}

/**
 * Readability judges the boxes around a figure by measures meant for link lists and galleries: a caption crediting
 * its source with a link, or the picture's own link, reads as a box of links, and two figures side by side without
 * a paragraph as a gallery, so the box went with its figures (Substack's captioned images, WordPress columns, image
 * pairs: every such figure of a page). A box whose words all lie in its figures, holding a figure with a picture,
 * only lays them out: it is replaced by what it holds, until the figures stand where no such measure reaches them.
 * So is one whose other words are a caption line, a paragraph without links (WordPress's group of figures under
 * "Figure 1. …"). A box with other words (titles linking to other stories, controls, a menu), a hidden box, and one
 * Readability's names set beside the article (related, promo, sidebar) are left to it.
 */
function unwrapFigureBoxes(document: Doc) {
  // Innermost first: a box of boxes of figures (columns of figures) is judged once its own boxes are gone.
  for (const box of [...document.querySelectorAll("div")].reverse()) {
    if (unseen(box) || namedBeside(box) || !box.querySelector("figure img, figure picture, figure video")) continue;
    const rest = box.cloneNode(true) as El;
    for (const figure of rest.querySelectorAll("figure")) figure.remove();
    const words = collapsed(rest.textContent);
    const lines = rest.querySelectorAll("p");
    const caption = lines.length === 1 && !lines[0]!.querySelector("a") && collapsed(lines[0]!.textContent) === words;
    if (words && !caption) continue;
    box.replaceWith(...box.childNodes);
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
 * Whether a class or id has one of the words by which Readability recognizes a byline, as a word of its own:
 * "post-author", "PostAuthor" and "author_box" do, "authorization" does not.
 */
function namesAuthor(el: El): boolean {
  const name = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`.replace(/([a-z])([A-Z])/g, "$1 $2");
  return name.toLowerCase().split(/[^a-z0-9]+/).some((word) => /^(?:authors?|byline|dateline|writtenby)$/.test(word));
}

/** An author's card is a photo with a few lines (name, title, bio); the longest seen ran to about 430 characters. */
const AUTHOR_CARD_CHARS = 1000;

/**
 * A box among the article's paragraphs that names its author and holds a picture and a few lines is the
 * author's card, not the article. Readability takes a byline only when its text is short, so the photo, name,
 * title, bio and contact lines of a card set after the text were stored as the article's end (techcrunch.com,
 * every article). The card goes before scoring; an author list or a contributions section without a picture,
 * and a longer box whatever its name, stay.
 */
function dropAuthorCards(document: Doc) {
  const flows = new Set<El>();
  for (const paragraph of document.querySelectorAll("p")) if (paragraph.parentElement) flows.add(paragraph.parentElement);
  for (const flow of flows) {
    for (const box of [...flow.children]) {
      if (box.localName === "p" || !namesAuthor(box) || !box.querySelector("img, picture")) continue;
      if (collapsed(box.textContent).length < AUTHOR_CARD_CHARS) box.remove();
    }
  }
}

/**
 * Readability reads "media" in a class or id as a social-media widget and drops the box. A box among the
 * article's paragraphs is often named for what it embeds ("media-column", "article-media": a figure, a chart,
 * a carousel of quotes), and every such box of a page went with its picture, caption or text. In the
 * paragraphs' flow (each paragraph and box beside them, and what they hold) the word is taken out of the
 * names before scoring; the rest still counts ("sponsor-media" still reads as sponsored, "social-media" as
 * a social widget).
 */
function keepMediaAmongParagraphs(document: Doc) {
  const flows = new Set<El>();
  for (const paragraph of document.querySelectorAll("p")) if (paragraph.parentElement) flows.add(paragraph.parentElement);
  const seen = new Set<El>();
  for (const flow of flows) {
    for (const box of flow.children) {
      for (const el of [box, ...box.querySelectorAll("[class], [id]")]) {
        if (seen.has(el)) continue;
        seen.add(el);
        for (const attribute of ["class", "id"]) {
          const value = el.getAttribute(attribute);
          if (!value || !/media/i.test(value)) continue;
          const rest = value.replace(/media/gi, "").replace(/\s+/g, " ").trim();
          if (rest) el.setAttribute(attribute, rest);
          else el.removeAttribute(attribute);
        }
      }
    }
  }
}

/**
 * Readability scores class names, and utility classes that only set overflow, scrolling or snapping read to
 * it as "hidden" or "scroll" ("overflow-hidden", "scroll-mt-24"): a box of the author's text with such a class
 * was dropped, and so was a figure's picture under Tailwind's tw- prefix ("tw-overflow-hidden"). They say nothing
 * about what the box holds, so they are taken off before scoring.
 */
const LAYOUT_CLASS = /^(?:[\w-]+:)*(?:tw-)?(?:overflow|overscroll|scroll|snap)-[\w-]+$/;
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
  const declared = declaredCover(document, url);
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
  markScreenReaderLinkText(document);
  showNoscriptPictures(document);
  unwrapPictureButtons(document);
  dropDarkThemeVersions(document);
  keepAsidesAmongParagraphs(document);
  dropAuthorCards(document);
  keepMediaAmongParagraphs(document);
  dropLayoutClasses(document);
  // After the names that only say "media" or set overflow are gone, which would count against a box of figures.
  unwrapFigureBoxes(document);
  // A document theme is not an article candidate: names such as "header-dark" can discard the root.
  document.documentElement.removeAttribute("class");
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(withoutScreenReaderLinkText(article.content), url));
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
  return { html: clean, text, images, via: "readability", ...date, cover: hasPicture(clean) ? null : declared };
}

export async function extractFromUrl(url: string, subject: string, rules: PageRules = {}, opts: { paidFallback?: boolean } = {}): Promise<ExtractedBody | null> {
  if (isVideoPageUrl(url)) return null;
  const target = new URL(url);
  if (rules.bodyUrlSuffix) target.pathname += rules.bodyUrlSuffix;
  let read: { body: ExtractedBody; pageUrl: string } | null = null;
  try {
    const res = await guardedFetch(target.href, { headers: languageHeaders(rules.acceptLanguage), timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024 });
    if (isVideoPageUrl(res.url)) return null;
    if (isSignInRedirect(url, res.url)) return null;
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /^(?:text\/plain|text\/markdown|text\/x-(?:diff|patch))\b/i.test(type)) {
      const text = res.text().trim();
      if (text.length < MIN_BODY_CHARS) return null;
      assertPageContent("", text);
      return { html: `<pre>${escapeXml(text)}</pre>`, text, images: [], via: "text" };
    }
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url, rules);
      if (got) read = { body: got, pageUrl: res.url };
    }
  } catch {
    // fall through to Jina
  }
  // Outside the page's read: a failure of the store while checking the cover is no unreadable page.
  if (read) return { ...read.body, cover: await articleCover(read.body.cover ?? null, url, read.pageUrl) };
  if (opts.paidFallback === false) return null;
  try {
    // The rendered text carries none of the page's metadata, so a body read this way has no cover.
    const extra = (DEPLOYMENT as { renderedArticleRemoveSelectors?: Record<string, string> }).renderedArticleRemoveSelectors?.[target.hostname];
    const page = await jinaRead(target.href, { purpose: "body_fallback", subject, removeSelector: extra ? `${PAGE_CHROME},${extra}` : PAGE_CHROME });
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
    // A cover decided before (when the article was first stored) stays.
    const cover = got.cover ? sql.json(got.cover as never) : null;
    if (!time && hash === row.content_hash) {
      await updatePresentation(tx, articleId, { html: got.html, media: row.media.length ? row.media : got.images });
      await tx`UPDATE articles SET body_status = 'ok', cover = coalesce(cover, ${cover}::jsonb), updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok', cover = coalesce(cover, ${cover}::jsonb),
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
  const got = found ? xArticleText(found, `https://x.com/i/status/${tweetId}`) : null;
  if (!got) {
    return markUnconfirmed(articleId, revision);
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null; x_article: { title?: string | null; text?: string; html?: string | null } | null }[]>`
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
      // The same words can have new media. Update their presentation without a new semantic revision.
      if (row.x_article?.html && got.html) {
        await updatePresentation(tx, articleId, { xArticleHtml: got.html });
      }
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
