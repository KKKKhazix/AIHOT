import { decodeHTMLStrict } from "entities/decode";

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A declared language wins. Otherwise Han text is Chinese only without Japanese or Korean script, and
 * a long text needs a real share of Han (a tenth of its letters), not a single character: an English
 * body that merely links to 「简体中文」 carries a handful of Han characters in thousands of letters
 * (issue #478), while Chinese news full of product names and links still runs to about a quarter Han.
 * Short strings (titles, posts, quotes) keep the presence test. Translation and every reading exit
 * share this rule, so a body that is translated is also shown translated.
 */
export function isChineseText(text: string, language?: string | null): boolean {
  const declared = language?.toLowerCase().split(/[-_]/)[0];
  if (declared === "zh") return true;
  if (declared && !["und", "unknown", "other", "zxx"].includes(declared)) return false;
  if (!/\p{Script=Han}/u.test(text) || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return false;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters < 200 || (text.match(/\p{Script=Han}/gu) ?? []).length / letters >= 0.1;
}

export function truncate(s: string, max: number, ellipsis = "…"): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - ellipsis.length)).join("").trimEnd() + ellipsis;
}

/**
 * Removes element markup while keeping `>` inside quoted attribute values: a link
 * title such as `title="Platforms > Xbox"` must not end the tag there and leak the
 * rest of it into the text.
 * This follows the small part of the HTML tokenizer needed here: an equals sign
 * starts a quoted value only after an attribute name. Comments, doctypes and
 * `< a>` keep the old first-`>` behavior because they are not element tags here.
 */
export function stripTagMarkup(html: string, replacement = " "): string {
  let out = "";
  let at = 0;
  while (at < html.length) {
    const start = html.indexOf("<", at);
    if (start < 0) return out + html.slice(at);
    out += html.slice(at, start);

    const firstEnd = html.indexOf(">", start + 1);
    if (firstEnd < 0) return out + html.slice(start);
    let end = firstEnd;
    // Only element attributes need quote handling; other markup keeps its existing behavior.
    if (/^<\/?[a-z]/i.test(html.slice(start, start + 3))) {
      let quote = "";
      let tagName = true;
      let attributeName = false;
      let value: "none" | "start" | "unquoted" = "none";
      let i = start + 1;
      for (; i < html.length; i += 1) {
        const char = html[i]!;
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === ">") {
          end = i;
          break;
        } else if (value === "unquoted") {
          if (/[\t\n\f\r ]/.test(char)) value = "none";
        } else if (value === "start") {
          if (/[\t\n\f\r ]/.test(char)) continue;
          value = "none";
          if (char === '"' || char === "'") quote = char;
          else value = "unquoted";
        } else if (tagName) {
          if (/[\t\n\f\r ]/.test(char)) tagName = false;
          else if (char === "/") continue;
          else if (char === "=") {
            tagName = false;
            attributeName = true;
          }
        } else if (char === "=") {
          if (attributeName) {
            attributeName = false;
            value = "start";
          } else {
            // A bare `=` is an attribute name in malformed HTML, not a value prefix.
            attributeName = true;
          }
        } else if (!/[\t\n\f\r ]/.test(char)) {
          attributeName = true;
        }
      }
      // An unfinished quoted tag consumes the rest of the document in the browser tokenizer.
      if (i === html.length) return out + replacement;
    }
    // Preserve the old result for the empty `<>` construct, which the old regex did not match.
    out += end === start + 1 ? "<>" : replacement;
    at = end + 1;
  }
  return out;
}

/**
 * Character references, numeric and named, as browsers read them in text; only those ending in a semicolon,
 * so an address keeps its "&copy=". Feeds escape text twice ("AI&amp;#8217;s", code shown as "&amp;lt;"),
 * and the text they mean is what readers expect, so "&amp;" goes first.
 */
export function decodeEntities(s: string): string {
  return decodeHTMLStrict(s.replace(/&amp;/g, "&"));
}

/** The text of HTML: without scripts and styles, every tag a word boundary, references decoded, whitespace collapsed. */
export function stripTags(html: string): string {
  return collapseWhitespace(decodeEntities(stripTagMarkup(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " "))));
}

/** HTML rendered into newline-separated blocks, every tag a word boundary and entities decoded. */
export function htmlBlockText(html: string | null | undefined): string {
  if (!html) return "";
  const withBreaks = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:p|div|li|h[1-6]|blockquote|figcaption|tr|dt|dd|caption|pre|section|article|aside|header|footer|br)\b[^>]*>/gi, "\n");
  return decodeEntities(stripTagMarkup(withBreaks, " "))
    .split(/\n+/)
    .map((line) => collapseWhitespace(line))
    .filter(Boolean)
    .join("\n");
}

/**
 * Combines text representations of the same document (such as plain body_text and rendered body_html)
 * without duplicating shared paragraphs or dropping blocks unique to a shorter representation.
 */
export function mergeDistinctText(...parts: Array<string | null | undefined>): string {
  const out: string[] = [];
  const seenWhole = new Set<string>();
  const seenBlocks = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const whole = collapseWhitespace(part);
    if (!whole || seenWhole.has(whole)) continue;
    seenWhole.add(whole);
    for (const rawBlock of part.split(/\n+/)) {
      const clean = collapseWhitespace(rawBlock);
      if (!clean) continue;
      if (clean.length >= 40 && seenBlocks.has(clean)) continue;
      if (clean.length >= 40) seenBlocks.add(clean);
      out.push(clean);
    }
  }
  return out.join("\n\n");
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** Share of CJK characters among letters; used to decide whether a title needs translation. */
export function cjkRatio(s: string): number {
  const letters = s.match(/[\p{L}]/gu) ?? [];
  if (letters.length === 0) return 0;
  const cjk = s.match(/[㐀-鿿豈-﫿]/g) ?? [];
  return cjk.length / letters.length;
}

export function guessLanguage(s: string): "zh" | "en" | "other" {
  const ratio = cjkRatio(s);
  if (ratio > 0.3) return "zh";
  if (/[a-z]/i.test(s)) return "en";
  return "other";
}
