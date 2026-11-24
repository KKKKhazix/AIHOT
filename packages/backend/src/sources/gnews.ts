// Google News wraps every entry's link in a redirect page: <link> points at
// news.google.com/rss/articles/<id>, whose target is resolved by the page's own JavaScript — there is
// no HTTP redirect to follow (the page answers 200). The target is decoded the way that page does it:
// the article page carries a per-article signature (data-n-a-sg / data-n-a-ts), and Google's internal
// batchexecute endpoint exchanges id + signature for the publisher URL. These are private interfaces
// that can change without notice; every failure keeps the listing's Google URL, so a broken decoder
// degrades a source to summaries instead of failing its collection run.
import { guardedFetch } from "../lib/http-fetch.ts";
import type { Candidate, SourceRow } from "./types.ts";

const ARTICLE_URL = /^https?:\/\/news\.google\.com\/rss\/articles\/([^?<]+)/;
const SIGNATURE = /data-n-a-sg="([^"]+)"/;
const TIMESTAMP = /data-n-a-ts="(\d+)"/;
const RESOLVED = /\[\\"garturlres\\",\\"(.*?)\\"/;

/** How uncached entries one run may decode; a first import decodes its bounded backfill, later runs only new entries. */
const MAX_DECODES_PER_RUN = 40;
/** After this many failed runs an entry is left at its Google URL instead of being retried forever. */
const MAX_FAILURES = 3;
/** The cache must not grow without bound; a feed's entries turn over, so a full cache is dropped. */
const MAX_CACHE = 1000;

export function isGoogleNewsUrl(url: string): boolean {
  return ARTICLE_URL.test(url);
}

/** The batchexecute exchange, as a seam so tests can serve recorded pages instead of Google. */
export type GoogleNewsFetcher = (url: string, init: { method: "GET" } | { method: "POST"; body: string }) => Promise<{ status: number; text: string }>;

async function fetcher(url: string, init: { method: "GET" } | { method: "POST"; body: string }): Promise<{ status: number; text: string }> {
  const res = await guardedFetch(url, init.method === "POST"
    ? { method: "POST", body: init.body, headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 }
    : { timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
  return { status: res.status, text: res.text() };
}

/** id + signature + timestamp → the publisher URL, or null when Google refused or answered without one. */
async function decode(fetch_: GoogleNewsFetcher, googleUrl: string): Promise<string | null> {
  const page = await fetch_(googleUrl, { method: "GET" });
  const sg = SIGNATURE.exec(page.text)?.[1];
  const ts = TIMESTAMP.exec(page.text)?.[1];
  if (!sg || !ts) return null;
  const aid = ARTICLE_URL.exec(googleUrl)![1];
  const payload = JSON.stringify(["garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    aid, Number(ts), sg]);
  const body = `f.req=${encodeURIComponent(JSON.stringify([[["Fbv4je", payload, null, "generic"]]]))}`;
  const answer = await fetch_("https://news.google.com/_/DotsSplashUi/data/batchexecute", { method: "POST", body });
  if (answer.status !== 200) return null;
  // The URL arrives inside Google's escaped payload: \u003d, \u0026 … are \uXXXX escapes, not
  // literals — sometimes doubly escaped (\\u003d), so the run of backslashes goes with the hex.
  const escaped = RESOLVED.exec(answer.text)?.[1];
  return escaped?.replace(/\\{1,2}u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) ?? null;
}

/**
 * Entries keep their listing URL unless the source asked for Google News decoding
 * (decodeGoogleNewsLinks). Decoded ones carry the publisher URL as their identity; a decode failure
 * keeps the Google URL, so the entry still stores as a summary instead of being lost. The cursor's
 * `gnews` object persists the google→publisher map (no refetch while the feed keeps offering the
 * entry) and per-entry failure counts (a stop after repeated failures). Only uncached entries cost
 * requests, up to the run's cap; the rest of the run is unaffected.
 */
export async function resolveGoogleNewsLinks<C extends Candidate>(
  candidates: C[],
  source: SourceRow,
  cursor: Record<string, unknown>,
  fetch_: GoogleNewsFetcher = fetcher,
): Promise<C[]> {
  if (source.config.decodeGoogleNewsLinks !== true) return candidates;
  const gnews = (cursor.gnews ??= {}) as { cache?: Record<string, string>; failures?: Record<string, number> };
  const cache = gnews.cache ??= {};
  const failures = gnews.failures ??= {};
  let spent = 0;
  return Promise.all(candidates.map(async (c) => {
    if (!isGoogleNewsUrl(c.url)) return c;
    const key = c.url;
    const known = cache[key];
    if (known) return { ...c, url: known };
    if (failures[key] !== undefined && failures[key] >= MAX_FAILURES) return c;
    if (spent >= MAX_DECODES_PER_RUN) return c;
    spent += 1;
    let resolved: string | null = null;
    // One retry: the endpoint is known to answer with a transient RPC error now and then.
    for (let attempt = 0; attempt < 2 && resolved === null; attempt++) {
      try {
        resolved = await decode(fetch_, key);
      } catch {
        resolved = null;
      }
    }
    if (resolved) {
      cache[key] = resolved;
      delete failures[key];
      return { ...c, url: resolved };
    }
    failures[key] = (failures[key] ?? 0) + 1;
    return c;
  })).then((out) => {
    if (Object.keys(cache).length > MAX_CACHE) gnews.cache = Object.fromEntries(Object.entries(cache).filter(([k]) => failures[k] === undefined));
    return out;
  });
}
