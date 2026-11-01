// JSON sources: plain JSON APIs, JSON embedded in HTML (script tags, window variables).
import { credential } from "../config.ts";
import { languageHeaders, requireOk } from "../lib/http-fetch.ts";
import { JINA_PREFIX, jinaRead } from "../providers/jina.ts";
import { fetchListing } from "./listing-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { readPublicationDate, type PublicationDate } from "./dates.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function firstString(obj: unknown, paths: string[] | undefined): string | null {
  for (const p of paths ?? []) {
    const v = getPath(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** "{path}" → encoded value, "{raw:path}" → raw value. Returns null when a referenced value is missing. */
export function renderTemplate(template: string, item: unknown): string | null {
  let missing = false;
  const out = template.replace(/\{(raw:)?([^}]+)\}/g, (_m, raw: string | undefined, path: string) => {
    const v = getPath(item, path);
    if (v === undefined || v === null || v === "") {
      missing = true;
      return "";
    }
    return raw ? String(v) : encodeURIComponent(String(v)).replace(/%2F/g, "/");
  });
  return missing ? null : out;
}

/** Calendar days and exact epoch/ISO times preserve the source's stated precision. */
export function toDate(v: unknown, unit: string | undefined, utcOffset: string | undefined): PublicationDate {
  const unknown = { publishedAt: null, publicationTime: null };
  if (v === null || v === undefined || v === "") return unknown;
  let text: string;
  try { text = String(v).trim(); } catch { return unknown; }
  if (unit === "epoch_ms" || unit === "epoch_s") {
    const date = new Date(Number(text) * (unit === "epoch_s" ? 1000 : 1));
    return Number.isFinite(date.getTime()) ? { publishedAt: date, publicationTime: date.toISOString() } : unknown;
  }
  if (unit === "yyyymmdd") {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    return m ? readPublicationDate(`${m[1]}-${m[2]}-${m[3]}`, utcOffset) : unknown;
  }
  return readPublicationDate(text, utcOffset);
}

function findKey(obj: unknown, key: string, depth = 0): unknown {
  if (depth > 12 || obj === null || typeof obj !== "object") return undefined;
  if (!Array.isArray(obj) && key in (obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Where the object or array literal starting at `start` ends (exclusive), skipping brackets inside strings; -1 when it does not. */
function literalEnd(text: string, start: number): number {
  let depth = 0, inStr: string | null = null, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function embeddedJson(html: string, source: SourceRow): unknown {
  const mode = source.config.mode;
  if (mode === "html_window_var") {
    const name = String(source.config.windowVar);
    const re = new RegExp(`(?:window\\.)?${name.replace(/[$]/g, "\\$")}\\s*=\\s*`);
    const m = re.exec(html);
    if (!m) throw new FetchError(`window.${name} not found`);
    const start = m.index + m[0].length;
    const end = literalEnd(html, start);
    if (end > 0) return JSON.parse(html.slice(start, end));
    throw new FetchError(`window.${name} not terminated`);
  }
  // html_json_key: scan JSON script blocks (e.g. __NEXT_DATA__) for the key.
  const key = String(source.config.jsonKey);
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1]!.trim();
    // Flight payloads carry the key escaped inside a string (\"items\").
    if (!body.includes(`"${key}"`) && !body.includes(`\\"${key}\\"`)) continue;
    const candidates = [body, body.replace(/^[^{[]*/, "").replace(/;?\s*$/, "")];
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c);
        const found = findKey(parsed, key);
        if (found) return { [key]: found };
      } catch {
        // Next.js flight payloads: self.__next_f.push([1,"..."])
      }
    }
    const flight = /"((?:[^"\\]|\\.)*)"\]\)\s*$/.exec(body);
    if (flight) {
      try {
        const decoded = JSON.parse(`"${flight[1]}"`) as string;
        // The key's own array, up to its matching bracket: its items may hold arrays of their own.
        const at = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\[`).exec(decoded);
        const start = at ? at.index + at[0].length - 1 : -1;
        const end = start < 0 ? -1 : literalEnd(decoded, start);
        if (end > 0) return { [key]: JSON.parse(decoded.slice(start, end)) };
      } catch {
        // keep scanning
      }
    }
  }
  throw new FetchError(`embedded key ${key} not found`);
}

export async function fetchJsonList(source: SourceRow): Promise<Candidate[]> {
  const c = source.config;
  const url = String(c.url ?? "");
  const headers: Record<string, string> = { accept: "application/json, text/html;q=0.9", ...languageHeaders(c.acceptLanguage), ...(c.headers ?? {}) };
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    const token = credential("collectors", "GITHUB_TOKEN");
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const embedded = c.mode === "html_json_key" || c.mode === "html_window_var";
  // A page that blocks our addresses can be read through Jina's rendered HTML, which keeps its scripts.
  const text = embedded && url.startsWith(JINA_PREFIX)
    ? (await jinaRead(url.slice(JINA_PREFIX.length), { purpose: "source_listing", subject: `source:${source.id}`, format: "html", perRead: true })).markdown
    : requireOk(await fetchListing(url, {
      redirectPolicy: "same-origin",
      method: c.method ?? "GET",
      headers: c.bodyJson ? { ...headers, "content-type": "application/json" } : headers,
      body: c.bodyJson ? JSON.stringify(c.bodyJson) : undefined,
      timeoutMs: 25_000,
    })).text();
  let data: unknown;
  if (embedded) data = embeddedJson(text, source);
  else {
    try {
      data = JSON.parse(text);
    } catch {
      throw new FetchError("response is not JSON");
    }
  }
  let items = c.itemsPath ? getPath(data, c.itemsPath) : c.jsonKey ? getPath(data, c.jsonKey) : data;
  if (c.itemsObjectValues && items && typeof items === "object" && !Array.isArray(items)) items = Object.values(items);
  if (!Array.isArray(items)) throw new FetchError("items path did not resolve to an array");

  const out: Candidate[] = [];
  for (const item of items) {
    if (c.requireBoolean && getPath(item, c.requireBoolean.path) !== c.requireBoolean.equals) continue;
    if (c.minNumeric && !(Number(getPath(item, c.minNumeric.path)) >= Number(c.minNumeric.min))) continue;
    const title = firstString(item, c.titlePaths);
    const url = (c.urlTemplate && renderTemplate(c.urlTemplate, item)) || (c.urlTemplateFallback && renderTemplate(c.urlTemplateFallback, item));
    if (!title || !url) continue;
    const externalId = c.externalIdPath ? getPath(item, c.externalIdPath) : null;
    const summary = firstString(item, c.summaryPaths);
    const summaryIsBody = c.summaryIsBody === true && !!summary;
    out.push({
      url,
      title: collapseWhitespace(stripTags(title)),
      author: firstString(item, c.authorPaths),
      ...toDate(getPath(item, c.publishedAtPath), c.publishedAtUnit, c.publishedAtUtcOffset),
      excerpt: summary ? collapseWhitespace(stripTags(summary)).slice(0, 2000) : null,
      bodyText: summaryIsBody ? stripTags(summary!) : null,
      bodyStatus: summaryIsBody ? "ok" : "pending",
      raw: { externalId: externalId ?? null },
    });
  }
  if (items.length > 0 && out.length === 0 && !c.requireBoolean && !c.minNumeric) throw new FetchError("no items mapped (check title/url paths)");
  return out;
}
