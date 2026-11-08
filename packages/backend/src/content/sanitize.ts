// One body representation for the web page, Markdown export and full RSS: whitelisted HTML.
// External HTML is never executed; images keep their original src and are signed at read time.
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import { addressRuns } from "@aihot/contracts/addresses";
import { isNonArticleImage } from "../lib/image-url.ts";
import { normalizeVideos } from "./video.ts";

const ALLOWED_TAGS = [
  "p", "br", "hr", "h2", "h3", "h4", "h5", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td", "caption", "a", "img", "figure", "figcaption", "strong", "em", "b", "i", "u", "s", "del",
  "sup", "sub", "mark", "span", "dl", "dt", "dd", "picture", "video", "source",
];

/** A class naming a promotion block (msr-promo, promo-box …), not text such as "promotion". */
const PROMO_CLASS = /(?:^|[-_])promo(?:$|[-_])/i;

/**
 * Drop promotions and non-video source elements before unknown containers are unwrapped. Rotating
 * promotions are not article material, and a nested fallback source is not a video candidate.
 */
function dropNonBodyMarkup(html: string): string {
  if (!/promo|<source\b/i.test(html)) return html;
  const $ = cheerio.load(html, null, false);
  $("source").filter((_, el) => !$(el).parent().is("video")).remove();
  $("[class]")
    .filter((_, el) => ($(el).attr("class") ?? "").split(/\s+/).some((c) => PROMO_CLASS.test(c)))
    .remove();
  return $.html();
}

/**
 * Elements whose content is never article text: dropped with everything inside, where other unknown
 * tags are only unwrapped. A page's <template> blocks held hundreds of thousands of characters of
 * base64 that surfaced as paragraphs.
 */
const DROP_WHOLE = [
  "script", "style", "noscript", "textarea", "option", "iframe", "object", "embed", "applet", "form", "input", "select",
  "button", "label", "fieldset", "legend", "svg", "link", "meta", "base", "title", "head", "template", "audio",
  "map", "area", "frame", "frameset", "track", "param",
  // MathML is unwrapped to its text; its LaTeX source and embedded markup are not text.
  "annotation", "annotation-xml", "mglyph",
];

export function sanitizeBody(html: string, baseUrl?: string): string {
  const cleaned = sanitizeHtml(dropNonBodyMarkup(html), {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: DROP_WHOLE,
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "width", "height", "title"],
      video: ["src", "poster", "width", "height", "controls", "playsinline", "preload"],
      source: ["src", "type"],
      code: ["class"],
      pre: ["class"],
      th: ["colspan", "rowspan", "align"],
      td: ["colspan", "rowspan", "align"],
      span: [],
    },
    allowedClasses: { code: [/^language-[\w-]+$/], pre: [/^language-[\w-]+$/] },
    allowedSchemes: ["http", "https"],
    allowedSchemesAppliedToAttributes: ["href", "src", "poster"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: true,
    transformTags: {
      h1: "h2",
      h6: "h5",
      div: (tagName, attribs) => ({ tagName: "p", attribs }),
      section: "p",
      article: "p",
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, ...(attribs.href ? { href: resolveUrl(attribs.href, baseUrl) } : {}) },
      }),
      img: (tagName, attribs) => {
        const src = unwrapProxyUrl(attribs["data-src"] || attribs["data-original"] || attribs.src || "");
        return { tagName, attribs: { ...attribs, src: resolveUrl(src, baseUrl) } };
      },
      // Preserve configured media URLs; custom lazy attributes only fill missing values.
      video: (tagName, attribs) => {
        const src = attribs.src?.trim() || attribs["data-src"]?.trim() || "";
        const poster = attribs.poster?.trim() || attribs["data-poster"]?.trim() || "";
        return { tagName, attribs: { ...attribs, src: resolveUrl(src, baseUrl), poster: resolveUrl(unwrapProxyUrl(poster), baseUrl) } };
      },
      source: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, src: resolveUrl(attribs.src?.trim() || attribs["data-src"]?.trim() || "", baseUrl) },
      }),
    },
    // Empty paragraphs and links go in normalizeBlocks, which sees nested images: a frame only knows its
    // direct children, so a paragraph holding a linked chart (<p><a><img></a></p>) and a link around a
    // framed picture (<a><div><picture><img></picture></div></a>) looked empty here.
    exclusiveFilter: (frame) =>
      frame.tag === "img" && (!frame.attribs.src || isNonArticleImage(frame.attribs.src, frame.attribs.width, frame.attribs.height)),
  });
  return normalizeBlocks(cleaned);
}

const BLOCK_TAGS = new Set(["p", "h2", "h3", "h4", "h5", "ul", "ol", "li", "blockquote", "pre", "table", "figure", "hr", "dl", "picture", "video"]);

/**
 * Re-parses the sanitised HTML the way browsers do: a block element closes an open paragraph, so
 * containers turned into <p> (nested divs) no longer leave nested or empty paragraphs behind. Links
 * and paragraphs with neither text nor media are dropped and loose top-level text is wrapped in its
 * own paragraph.
 */
export function normalizeBlocks(html: string): string {
  const $ = cheerio.load(html, null, false);
  normalizeVideos($);
  for (const tag of ["a", "p"]) {
    $(tag).each((_, el) => {
      const node = $(el);
      if (!node.text().trim() && !node.find("img, video, picture").length) node.remove();
    });
  }
  // The frame around a linked picture (<a><div><picture>) became a paragraph, which Markdown cannot
  // hold inside a link; paragraphs of text in a link stay.
  $("a p").each((_, el) => {
    if (!$(el).text().trim()) $(el).replaceWith($(el).contents());
  });
  const out: string[] = [];
  let run: string[] = [];
  let meaningful = false;
  const flush = () => {
    if (meaningful) out.push(`<p>${run.join("").trim()}</p>`);
    run = [];
    meaningful = false;
  };
  for (const node of $.root().contents().toArray()) {
    if (node.type === "tag" && BLOCK_TAGS.has(node.name)) {
      flush();
      out.push($.html(node));
    } else if (node.type === "text" || node.type === "tag") {
      run.push($.html(node));
      if ($(node).text().trim() || (node.type === "tag" && $(node).is("img, a:has(img), br") && node.name !== "br")) meaningful = true;
    }
  }
  flush();
  return out.join("").trim();
}

/**
 * Short blocks a news page puts after the article (one ends in "Topics", "Subscribe for the
 * industry's biggest tech news", "Latest in AI"). Only headings and calls to action without a full
 * stop, only at the very end of an extracted page, one block at a time: an article's own sentences stay.
 */
const TRAILING_CHROME = [
  /^topics$/i, /^tags?$/i, /^latest in [\p{L}\s&-]{1,30}$/iu, /^latest (?:news|stories)$/i, /^most (?:popular|read)$/i,
  /^related (?:articles|posts|stories|content|reading|coverage)$/i, /^more (?:stories|articles|news)$/i, /^(?:keep reading|read next|up next)$/i,
  /^(?:you (?:might|may) also like|recommended(?: for you)?)$/i, /^(?:subscribe|sign up)\b.{0,80}$/i, /^share (?:this|on)\b.{0,40}$/i,
  /^follow us\b.{0,40}$/i, /^advertisement$/i,
];

export function trimTrailingChrome(html: string): string {
  const $ = cheerio.load(html, null, false);
  let blocks = $.root().children().toArray();
  let removed = false;
  while (blocks.length > 1) {
    const last = $(blocks[blocks.length - 1]!);
    const text = collapse(last.text());
    if (last.find("img, video, picture").length || /[.。!！?？:：]$/.test(text) || !TRAILING_CHROME.some((re) => re.test(text))) break;
    last.remove();
    blocks = blocks.slice(0, -1);
    removed = true;
  }
  return removed ? $.html() : html;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

const OWN_PROXY = /^(?:https?:\/\/[^/?#]+)?\/api\/img-proxy\?/i;

/**
 * The image an address of our own image proxy stands for. Older bodies were saved with the proxy's
 * relative address (`/api/img-proxy?u=…&exp=…&sig=…`); resolved against the article's own site it
 * pointed nowhere. The source image is the `u` it wraps, signed again when a page is served.
 */
export function unwrapProxyUrl(src: string): string {
  const s = src.trim();
  if (!OWN_PROXY.test(s)) return src;
  const u = new URLSearchParams(s.slice(s.indexOf("?") + 1).replace(/&amp;/g, "&")).get("u");
  return u && /^https?:\/\//i.test(u) ? u : src;
}

function resolveUrl(href: string, base?: string): string {
  if (!href) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function link(href: string, text: string): string {
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escHtml(text)}</a>`;
}

/** Escaped text with its bare addresses made into links, read as the pages read them (addresses.ts). */
function linkify(text: string): string {
  return addressRuns(text).map((run) => (typeof run === "string" ? escHtml(run) : link(run.href, run.text))).join("");
}

/** Inline code, **bold** and [text](url), then bare addresses; everything else escaped. */
function inline(text: string): string {
  return text
    .split(INLINE)
    .map((part, i) => {
      if (i % 2 === 0) return linkify(part);
      if (part.startsWith("`")) return `<code>${escHtml(part.slice(1, -1))}</code>`;
      if (part.startsWith("**")) return `<strong>${linkify(part.slice(2, -2))}</strong>`;
      const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)!;
      return link(m[2]!, m[1]!);
    })
    .join("");
}

/** A list line: a bullet and a space, or a number with "." or ")" and a space, or with a Chinese "、". */
const LIST_ITEM = /^[ \t]*(?:[-*+•·▪◦●➤][ \t]+|(\d{1,3})(?:[.)][ \t]+|、[ \t]*))(?=\S)/;
const QUOTE = /^[ \t]*>[ \t]?/;
const HEADING = /^(#{1,6})[ \t]+(.+)$/;

/** Which list a line belongs to: numbered, bulleted, or none. */
const listKind = (line: string): "ol" | "ul" | null => {
  const m = LIST_ITEM.exec(line);
  return m ? (m[1] ? "ol" : "ul") : null;
};

/** How many lines from `from` continue one list: lines of the same kind, and in `whole` only one-line blocks. */
function listRun(lines: string[], from: number, whole = false): number {
  const kind = whole && lines[from]!.includes("\n") ? null : listKind(lines[from]!);
  let end = from;
  while (kind && end < lines.length && !(whole && lines[end]!.includes("\n")) && listKind(lines[end]!) === kind) end++;
  return end - from;
}

/** List lines as a list, an ordered one numbered from its first line's number. */
function list(lines: string[]): string {
  const first = LIST_ITEM.exec(lines[0]!)?.[1];
  const tag = first ? "ol" : "ul";
  const start = first && Number(first) !== 1 ? ` start="${Number(first)}"` : "";
  return `<${tag}${start}>${lines.map((l) => `<li>${inline(l.replace(LIST_ITEM, ""))}</li>`).join("")}</${tag}>`;
}

const paragraph = (lines: string[]) => `<p>${lines.map(inline).join("<br>")}</p>`;

/**
 * One blank-line separated block: fenced code, a quote, a heading, or lines. Two or more list lines in a
 * row are a list ("亮点：" and its "- " lines under it); the lines around them stay paragraphs, and a single
 * numbered line stays text (a section title such as "1. 股票代码ANT").
 */
function block(para: string): string {
  if (para.startsWith("```")) {
    const code = para.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
    return `<pre><code>${escHtml(code)}</code></pre>`;
  }
  const lines = para.split("\n").filter((l) => l.trim());
  if (lines.length && lines.every((l) => QUOTE.test(l))) return `<blockquote><p>${lines.map((l) => inline(l.replace(QUOTE, ""))).join("<br>")}</p></blockquote>`;
  const heading = lines.length === 1 ? HEADING.exec(lines[0]!) : null;
  if (heading) {
    const level = Math.min(heading[1]!.length + 1, 6);
    return `<h${level}>${inline(heading[2]!)}</h${level}>`;
  }
  let html = "";
  let text: string[] = [];
  for (let i = 0; i < lines.length;) {
    const run = listRun(lines, i);
    if (run < 2) {
      text.push(lines[i++]!);
      continue;
    }
    if (text.length) html += paragraph(text);
    text = [];
    html += list(lines.slice(i, i + run));
    i += run;
  }
  return text.length ? html + paragraph(text) : html;
}

/**
 * Plain text to HTML, for sources that only give text (X posts, translations): paragraphs and line
 * breaks, the few Markdown marks people type (code, bold, links, lists, quotes, headings) and safe
 * links for bare addresses. The text is never taken as HTML. A line of spaces parts paragraphs like an
 * empty one, and list items written a blank line apart are still one list.
 */
export function textToHtml(text: string): string {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n(?:[ \t 　]*\n)+/).map((para) => para.trim()).filter(Boolean);
  let html = "";
  for (let i = 0; i < paras.length;) {
    const run = listRun(paras, i, true);
    if (run < 2) {
      html += block(paras[i++]!);
      continue;
    }
    html += list(paras.slice(i, i + run));
    i += run;
  }
  return html;
}
