// Outward HTTP behaviour, defined once: CORS, the public interface version, redirects and which process
// owns a path, the engine's and then those of the site's modules. The API server and the web server both
// read this module.
import { ABOUT, POLICY, SITE } from "@aihot/site";
import { MODULES } from "@aihot/site/modules";

/** CORS for /api/v1/* and /openapi-v1.json. */
export const PUBLIC_API_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, If-None-Match, If-Modified-Since",
  "Access-Control-Expose-Headers": [
    "ETag",
    "Last-Modified",
    "Retry-After",
    "X-Request-Id",
    "Deprecation",
    "Sunset",
    "Link",
    ...Object.keys(POLICY.terms.headers ?? {}),
  ].join(", "),
  "Access-Control-Max-Age": "86400",
};

/** MCP and the v1 OpenAPI carry one public version, the site's (site/site.ts); it only goes up. */
export const PUBLIC_INTERFACE_VERSION = SITE.interfaceVersion;

export const NO_STORE = "no-store";

export interface RedirectRule {
  match: "exact" | "regex" | "prefix" | "canonical";
  /** For canonical, the fixed lowercase address, whose aliases redirect to this path. */
  path: string;
  status: 301 | 302 | 307 | 308 | 404 | 410;
  /** Relative Location. `$1`… refer to regex groups; `*` appends the remainder for prefix rules. */
  location?: string;
  keepQuery?: boolean;
  /** Appended after the query, as `#fragment`. */
  fragment?: string;
  headers?: Record<string, string>;
  why?: string;
}

/** Redirects. Locations are always relative, so they stay right behind any proxy. */
const ENGINE_REDIRECTS: RedirectRule[] = [
  {
    match: "regex",
    path: "^/(all|about|agent|changelog|feedback|starred|more|privacy|terms)/+$",
    status: 301,
    location: "/$1",
    keepQuery: true,
  },
  {
    match: "regex",
    path: "^/(feed|rss|rss\\.xml|atom\\.xml)$",
    status: 301,
    location: "/feed.xml",
    keepQuery: true,
    why: "RSS reader aliases",
    // A subscription address may carry its reader's own query, which the Location repeats: the redirect
    // never enters shared caches.
    headers: { "Cache-Control": "private, no-store" },
  },
];


export interface RedirectDecision {
  status: number;
  location: string | null;
  headers: Record<string, string>;
}

/** Match static aliases before routing, decoding unreserved bytes without turning escaped separators into paths. */
function normalizedPublicPath(pathname: string): string {
  if (!pathname.startsWith("/") || !/[%A-Z\\]|\/(?:\/|\.{1,2}(?:\/|$)|$)/.test(pathname)) return pathname;
  // An origin-form path starting with // still belongs to this host. URL handles dot segments.
  const path = new URL("http://redirect.local" + pathname).pathname;
  return path.replace(/%([a-f0-9]{2})/gi, (encoded, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[a-z0-9._~-]$/i.test(char) ? char : encoded;
  }).toLowerCase().replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

export function resolveRedirect(pathname: string, search: string): RedirectDecision | null {
  let normalized: string | undefined;
  for (const rule of tables().redirects) {
    let location: string | null = null;
    if (rule.match === "canonical") {
      if (pathname === rule.path || (normalized ??= normalizedPublicPath(pathname)) !== rule.path) continue;
      location = rule.path;
    } else if (rule.match === "exact") {
      if (pathname !== rule.path) continue;
      location = rule.location ?? null;
    } else if (rule.match === "prefix") {
      const inTree = rule.path.endsWith("/")
        ? pathname.startsWith(rule.path)
        : pathname === rule.path || pathname.startsWith(`${rule.path}/`);
      if (!inTree) continue;
      location = rule.location ? rule.location.replace("*", pathname.slice(rule.path.length)) : null;
    } else {
      const m = new RegExp(rule.path).exec(pathname);
      if (!m) continue;
      location = rule.location ? rule.location.replace(/\$(\d)/g, (_s, i: string) => m[Number(i)] ?? "") : null;
    }
    if (location && rule.keepQuery && search) location += search;
    if (location && rule.fragment) location += `#${rule.fragment}`;
    return { status: rule.status, location, headers: rule.headers ?? {} };
  }
  const page = pastedPage(pathname);
  // The Location repeats the reader's query, so it never enters shared caches.
  if (page && !isApiOwned(pathname)) return { status: 301, location: page + search, headers: { "Cache-Control": "private, no-store" } };
  return null;
}

/** ASCII punctuation that no page address holds and that prose puts right after a link: quotes, brackets, Markdown. */
const TAIL_ASCII = new Set("\"'()*+,;<>[\\]^`{|}!");

/**
 * Whether a character starts the text a pasted link swallowed: a space or control, the ASCII punctuation above,
 * general punctuation (dashes, curly quotes, zero-width marks) or CJK and full-width punctuation. Letters of any
 * script do not: a site's slugs may be written in them.
 */
function startsTail(char: string): boolean {
  const c = char.codePointAt(0)!;
  return c <= 0x20 || c === 0x7f || TAIL_ASCII.has(char) || (c >= 0x2000 && c <= 0x206f)
    || (c >= 0x3000 && c <= 0x3004) || (c >= 0x3008 && c <= 0x3020)
    || (c >= 0xff01 && c <= 0xff0f) || (c >= 0xff1a && c <= 0xff20) || (c >= 0xff3b && c <= 0xff40) || (c >= 0xff5b && c <= 0xff65);
}

/**
 * A link pasted into prose often takes the text after it along: "…/agent。", "…/agent**", "…/daily）", "…/daily."
 * (each a 404 for the reader who opens it). A page path is cut where that text starts, with a sentence's closing dots,
 * and the reader goes to the page the link meant; api paths answer as they are. The tail is found in the decoded path,
 * but the Location keeps the request's own spelling: escaped letters and separators (%23) stay escaped. The cut stays
 * on this site: repeated slashes collapse, and a dot segment, or a character the request carried unescaped beyond
 * visible ASCII, is left to the page's own answer.
 */
function pastedPage(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // Each character with its spelling in the request: itself, or the escapes of its UTF-8 bytes (decodeURIComponent
  // accepted them, so there are exactly that many).
  const units: Array<{ char: string; spelling: string }> = [];
  let at = 0;
  for (const char of decoded) {
    const c = char.codePointAt(0)!;
    const length = pathname[at] === "%" ? 3 * (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4) : char.length;
    units.push({ char, spelling: pathname.slice(at, at + length) });
    at += length;
  }
  const cut = units.findIndex((u) => startsTail(u.char));
  let end = cut < 0 ? units.length : cut;
  let dots = end;
  while (dots > 0 && units[dots - 1]!.char === ".") dots--;
  if (dots < end && dots > 0 && /^[A-Za-z0-9]$/.test(units[dots - 1]!.char)) end = dots;
  if (end === units.length) return null;
  const kept = units.slice(0, end);
  const path = kept.map((u) => u.char).join("").replace(/\/{2,}/g, "/");
  const location = kept.map((u) => u.spelling).join("").replace(/\/{2,}/g, "/") || "/";
  return /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || /[^\x21-\x7e]/.test(location) ? null : location;
}

/** OAuth discovery probes from MCP clients: a cheap 404, never a rendered page. */
export const OAUTH_PROBE_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/api/mcp",
  "/api/mcp/.well-known/oauth-protected-resource",
  "/api/mcp/.well-known/oauth-authorization-server",
  "/api/mcp/.well-known/openid-configuration",
];

/** Root addresses of the about page's contact codes that were linked from outside (ABOUT.maker), served by routes/static.ts. */
export const CONTACT_ALIASES = (["wechat", "feishu"] as const).flatMap((slot) => {
  const file = ABOUT.maker?.[slot]?.alias;
  return file ? [{ slot, file }] : [];
});

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Paths served by the api process; everything else is the web process. The web server proxies these to
 * the api (a reverse proxy in front may also route them straight to it). Patterns are anchored so page
 * paths such as /feedback never fall into /feed.
 */
const ENGINE_API_PATHS: RegExp[] = [
  /^\/api\//,
  /^\/feed(\.xml|\/.*)?$/,
  /^\/(rss|rss\.xml|atom\.xml)$/,
  /^\/openapi-v1\.json$/,
  /^\/(llms\.txt|robots\.txt|sitemap\.xml|manifest\.webmanifest)$/,
  /^\/sitemaps\//,
  /^\/\.well-known\//,
  /^\/(favicon\.ico|icon\.png|icon-192\.png|apple-icon\.png|logo\.svg)$/,
  ...(SITE.rootIcons.length ? [new RegExp(`^\\/(${SITE.rootIcons.map(literal).join("|")})$`)] : []),
  /^\/(og|contact)\//,
  ...(CONTACT_ALIASES.length ? [new RegExp(`^\\/(${CONTACT_ALIASES.map((a) => literal(a.file)).join("|")})$`)] : []),
  /^\/[0-9a-f]{32}\.txt$/,
  /^\/items\/[^/]+\/markdown$/,
];

/** Read on first use, so a browser bundle that only needs this module's constants leaves the modules' tables out. */
let built: { redirects: RedirectRule[]; apiPaths: RegExp[] } | null = null;
function tables() {
  built ??= {
    redirects: [...ENGINE_REDIRECTS, ...MODULES.flatMap((m) => m.redirects ?? [])],
    apiPaths: [...ENGINE_API_PATHS, ...MODULES.flatMap((m) => m.apiPaths ?? [])],
  };
  return built;
}

/** The engine's api paths, then the site's modules'. */
export function apiOwnedPatterns(): readonly RegExp[] {
  return tables().apiPaths;
}

export function isApiOwned(pathname: string): boolean {
  return tables().apiPaths.some((re) => re.test(pathname));
}
