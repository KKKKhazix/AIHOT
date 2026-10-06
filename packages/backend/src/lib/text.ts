export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number, ellipsis = "…"): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - ellipsis.length)).join("").trimEnd() + ellipsis;
}

/**
 * Removes element markup while keeping `>` inside quoted attribute values.
 * A VGC link title such as `title="Platforms > Xbox"` used to be split at that
 * character by the old regular expression, leaking the rest of the tag into text.
 * This follows the small part of the HTML tokenizer needed here: an equals sign
 * starts a quoted value only after an attribute name. Comments, doctypes and
 * `< a>` keep the old first-`>` behavior because they are not element tags here.
 */
function stripTagMarkup(html: string): string {
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
      if (i === html.length) return out + " ";
    }
    // Preserve the old result for the empty `<>` construct, which the old regex did not match.
    out += end === start + 1 ? "<>" : " ";
    at = end + 1;
  }
  return out;
}

export function stripTags(html: string): string {
  const text = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, "\n");
  return collapseWhitespace(
    stripTagMarkup(text)
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'"),
  );
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
