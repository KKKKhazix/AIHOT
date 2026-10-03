// Server-side HTTP client for route loaders, and the cache lifetimes routes give their pages. The web
// process never touches the database; SSR reads the api over loopback with keep-alive, one or two
// requests per page.
import { data, redirect } from "react-router";

/** Where the api listens (API_BASE_URL; Docker Compose sets it); development uses the default. */
export const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:3001";

/** An api answer other than 2xx. A merged story answers 308 with the story it now lives in. */
class ApiError extends Error {
  readonly status: number;
  readonly mergedInto: string | null;
  constructor(status: number, mergedInto: string | null) {
    super(`api ${status}`);
    this.status = status;
    this.mergedInto = mergedInto;
  }
}

export async function apiGet<T>(path: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; responseHeaders?: Headers }): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { accept: "application/json", "x-aihot-ssr": "1", ...init?.headers },
    redirect: "manual",
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { mergedInto?: string } | null;
    throw new ApiError(res.status, res.status === 308 ? (body?.mergedInto ?? null) : null);
  }
  res.headers.forEach((value, name) => init?.responseHeaders?.set(name, value));
  return (await res.json()) as T;
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

/** How long shared caches may keep a page; the web server writes its final cache headers (server.ts). */
export function edgeTtl(seconds: number): Record<string, string> {
  return { "Cache-Control": `public, s-maxage=${seconds}` };
}

/**
 * Cache headers for a page of selected items: shared caches keep it at most `maxSeconds`, and never
 * past the absolute deadline the api gave a proxy or CDN in front for its data.
 */
export function apiDeadlineCache(maxSeconds: number, now = Date.now(), upstream?: Headers): Record<string, string> {
  let deadline = Math.floor(now / 1000) + maxSeconds;
  const sourceDeadline = upstream?.get("X-Accel-Expires");
  if (sourceDeadline?.startsWith("@")) deadline = Math.min(deadline, Number(sourceDeadline.slice(1)));
  if (sourceDeadline === "0" || /(?:no-cache|no-store)/i.test(upstream?.get("Cache-Control") ?? "")) deadline = Math.floor(now / 1000);
  const seconds = Math.max(0, Math.floor(deadline - now / 1000));
  return seconds > 0 ? { ...edgeTtl(seconds), "X-Accel-Expires": `@${deadline}` } : { "Cache-Control": "no-cache", "X-Accel-Expires": "0" };
}
