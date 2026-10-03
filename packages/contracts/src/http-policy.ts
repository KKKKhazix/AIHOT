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
  match: "exact" | "regex" | "prefix";
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
  { match: "prefix", path: "/sources", status: 302, location: "/admin/sources*", why: "admin bookmarks" },
];


export interface RedirectDecision {
  status: number;
  location: string | null;
  headers: Record<string, string>;
}

export function resolveRedirect(pathname: string, search: string): RedirectDecision | null {
  for (const rule of tables().redirects) {
    let location: string | null = null;
    if (rule.match === "exact") {
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
  return null;
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

/** The engine's redirects, then the site's modules', in the order they are matched. */
export function redirectRules(): readonly RedirectRule[] {
  return tables().redirects;
}

/** The engine's api paths, then the site's modules'. */
export function apiOwnedPatterns(): readonly RegExp[] {
  return tables().apiPaths;
}

export function isApiOwned(pathname: string): boolean {
  return tables().apiPaths.some((re) => re.test(pathname));
}
