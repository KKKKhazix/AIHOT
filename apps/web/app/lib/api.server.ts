// Server-side HTTP client for route loaders, and the cache lifetimes routes give their pages. The web
// process never touches the database; SSR reads the api over loopback with keep-alive, one or two
// requests per page.
import { data, redirect, type HeadersArgs } from "react-router";
import { logError } from "./errors.server.ts";

/** Where the api listens (API_BASE_URL, set by the deployment); development uses the default. */
export const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:3001";

/** An api answer other than 2xx. A merged story answers 308 with the story it now lives in. */
class ApiError extends Error {
  readonly status: number;
  readonly mergedInto: string | null;
  readonly requestId: string | null;
  constructor(status: number, mergedInto: string | null, requestId: string | null) {
    super(`api ${status}`);
    this.status = status;
    this.mergedInto = mergedInto;
    this.requestId = requestId;
  }
}

export async function apiGet<T>(path: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; responseHeaders?: Headers }): Promise<T> {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: { accept: "application/json", "x-aihot-ssr": "1", ...init?.headers },
      redirect: "manual",
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { mergedInto?: string } | null;
      throw new ApiError(res.status, res.status === 308 ? (body?.mergedInto ?? null) : null, res.headers.get("X-Request-Id"));
    }
    res.headers.forEach((value, name) => init?.responseHeaders?.set(name, value));
    return (await res.json()) as T;
  } catch (error) {
    if (!init?.signal?.aborted && (!(error instanceof ApiError) || error.status >= 500)) {
      logError(error, { msg: "ssr api request failed", method: "GET", path,
        ...(error instanceof ApiError ? { status: error.status, upstreamRequestId: error.requestId } : {}),
      });
    }
    throw error;
  }
}

/**
 * Maps API failures to route responses: real 404s, the permanent redirect of a merged page (`merged`
 * gives the page of the id it was merged into), the search-busy page, otherwise 503.
 */
export async function loadOr404<T>(path: string, opts: { busyRedirect?: string; merged?: (id: string) => string; responseHeaders?: Headers; signal?: AbortSignal } = {}): Promise<T> {
  try {
    return await apiGet<T>(path, { responseHeaders: opts.responseHeaders, signal: opts.signal });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    if (error instanceof ApiError) {
      if (error.status === 404) throw data({ message: "not_found" }, { status: 404 });
      if (error.mergedInto && opts.merged) throw redirect(opts.merged(error.mergedInto), 308);
      if (error.status === 503 && opts.busyRedirect) throw redirect(opts.busyRedirect);
      if (error.status === 400) throw data({ message: "bad_request" }, { status: 400 });
    }
    throw data({ message: "unavailable" }, { status: 503 });
  }
}

/** Browsers keep a page at most this long, so a withdrawal reaches them within minutes. */
export const BROWSER_MAX_SECONDS = 300;

/** How long shared caches may keep a page that has no data to reuse; the web server writes its final cache headers (server.ts). */
export function edgeTtl(seconds: number): Record<string, string> {
  return { "Cache-Control": `public, s-maxage=${seconds}` };
}

/**
 * A page's data with the one lifetime it is cached for: shared caches keep it `seconds`, never past the
 * absolute deadline the api gave a proxy or CDN in front for its own data (`upstream`). The browser
 * reuses the result until `expiresAt`, that same deadline but at most BROWSER_MAX_SECONDS from now.
 * Time the page already spent in a cache is used up, and a revisit never renews it. Pair it with `pageHeaders`.
 */
export function cachedPage<T extends object>(seconds: number, value: T, upstream?: Headers) {
  const now = Date.now();
  const second = Math.floor(now / 1000);
  let deadline = second + seconds;
  const sourceDeadline = upstream?.get("X-Accel-Expires");
  if (sourceDeadline?.startsWith("@")) deadline = Math.min(deadline, Number(sourceDeadline.slice(1)));
  if (sourceDeadline === "0" || /(?:no-cache|no-store)/i.test(upstream?.get("Cache-Control") ?? "")) deadline = second;
  const left = (until: number) => Math.floor(until - now / 1000);
  const browserDeadline = Math.min(deadline, second + BROWSER_MAX_SECONDS);
  return data(
    { ...value, expiresAt: left(browserDeadline) > 0 ? browserDeadline * 1000 : 0 },
    { headers: left(deadline) > 0 ? { ...edgeTtl(left(deadline)), "X-Accel-Expires": `@${deadline}` } : { "Cache-Control": "no-cache", "X-Accel-Expires": "0" } },
  );
}

/** The `headers` export of a page whose loader returns `cachedPage`. */
export function pageHeaders({ loaderHeaders }: HeadersArgs) {
  return loaderHeaders;
}
