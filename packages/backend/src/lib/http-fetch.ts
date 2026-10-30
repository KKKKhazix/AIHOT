// Outbound HTTP for collectors, the image proxy and the paid APIs: SSRF guard, routing, limits.
import net from "node:net";
import { addAbortListener } from "node:events";
import { Agent, Pool, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { config } from "../config.ts";
import { assertPublicUrl, guardedLookup } from "./url.ts";
import { createEgressProxy, createEgressResolver, OUTBOUND_HTTP_OPTIONS } from "./egress-proxy.ts";
import { DEPLOYMENT, SITE } from "@aihot/site";

/**
 * Where a request leaves the host. "egress" (collection, bodies, images and other public data) goes
 * through the egress proxy when EGRESS_PROXY_URL is set (for example a rule-based proxy that connects
 * .cn and .local names and Chinese or private addresses directly and sends the rest abroad); the names
 * and address literals such a proxy would connect directly, plus the deployment's verified direct
 * hosts, are connected here instead, so the
 * connect-time address check still applies. A name sent through the proxy is resolved through it too
 * (egress-proxy.ts), and the tunnel goes to the checked address. "direct" is for paid APIs called
 * straight (SocialData, Dajiala) and the site's own addresses. A listing fetch from a host in
 * PRIVATE_FEED_HOSTS is connected directly too.
 */
export type EgressRoute = "egress" | "direct";

let proxyAgent: ProxyAgent | null = null;
let directAgent: Agent | null = null;
let privateFeedAgent: Agent | null = null;
let pinnedCurve: Agent | null = null;
let resolveEgress: ReturnType<typeof createEgressResolver> | null = null;

function egressResolver() {
  return resolveEgress ??= createEgressResolver(config.egressProxyUrl!);
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function proxied(url: URL, route: EgressRoute, privateHosts: readonly string[]): boolean {
  if (route !== "egress" || !config.egressProxyUrl) return false;
  const host = hostOf(url);
  return net.isIP(host) === 0 && !privateHosts.includes(host) && !host.endsWith(".cn") && !host.endsWith(".local") && !DEPLOYMENT.directFetchHosts.includes(host);
}

// Per-edition limits are optional; missing hosts keep the runtime default (normally 16 KiB).
function destinationPool(origin: string | URL, options: object): Pool {
  const limits = (DEPLOYMENT as { responseHeaderLimits?: Partial<Record<string, number>> }).responseHeaderLimits;
  return new Pool(origin, { ...options, maxHeaderSize: limits?.[new URL(origin).hostname] });
}

function dispatcherFor(viaProxy: boolean, privateHost: boolean): Dispatcher | undefined {
  if (viaProxy) {
    proxyAgent ??= createEgressProxy(config.egressProxyUrl!, egressResolver(), destinationPool);
    return proxyAgent;
  }
  if (config.allowPrivateNetworkFetch) return undefined;
  if (privateHost) {
    // The listed name may resolve to a private service; the address dialled is still checked.
    privateFeedAgent ??= new Agent({ ...OUTBOUND_HTTP_OPTIONS, factory: destinationPool, connect: {
      lookup: ((hostname: string, options: never, callback: never) => guardedLookup(hostname, options, callback, config.privateFeedHosts)) as never,
    } });
    return privateFeedAgent;
  }
  // Direct connections resolve through the guarded lookup: the address actually dialled is checked.
  directAgent ??= new Agent({ ...OUTBOUND_HTTP_OPTIONS, connect: { lookup: guardedLookup as never }, factory: destinationPool });
  return directAgent;
}

/**
 * Some government TLS stacks answer Node's preferred X25519 key share with a point OpenSSL refuses
 * (ERR_SSL_BAD_ECPOINT, e.g. mzt.hunan.gov.cn): the page loads in a browser and in curl, and with
 * the curve pinned to P-256. Node's "auto" curve list starts with X25519, so the same request is
 * retried once on an agent that offers only P-256. Every browser still negotiates P-256, so pinning
 * loses nothing.
 */
function pinnedCurveAgent(): Agent | undefined {
  // With the private-network allowance on, requests already use undici's default agents and no
  // address check runs; pinning a curve would silently re-introduce the check for those hosts.
  if (config.allowPrivateNetworkFetch) return undefined;
  pinnedCurve ??= new Agent({ ...OUTBOUND_HTTP_OPTIONS, connect: { lookup: guardedLookup as never, ecdhCurve: "prime256v1" }, factory: destinationPool });
  return pinnedCurve;
}

/**
 * The refused key share, read off the cause chain undici wraps it in. It can only come from the key
 * exchange, before any request byte is sent, so the retry never replays a request a server has seen
 * (a paid API would bill it twice). EPROTO is not matched: it also follows a request already sent.
 */
function brokenHandshake(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause; depth++) {
    const code = (cause as { code?: string }).code;
    if (code === "ERR_SSL_BAD_ECPOINT") return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

export interface GuardedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Return the first maxBytes of a longer body (`truncated`) instead of failing. */
  truncate?: boolean;
  /** Follow redirects manually so every hop passes the SSRF guard. */
  maxRedirects?: number;
  /** Keeps every hop on the original origin when the URL itself may carry credentials (never relaxes the automatic rule). */
  redirectPolicy?: "same-origin";
  /** "egress" by default; see EgressRoute. */
  route?: EgressRoute;
  /**
   * The URL is an address the administrator configured (listing-fetch.ts): when its host is listed in
   * PRIVATE_FEED_HOSTS it may be a private service. Redirects to any other host keep the normal rules.
   */
  privateFeedHost?: boolean;
}

export interface GuardedResponse {
  status: number;
  url: string;
  headers: Headers;
  body: Buffer;
  /** The body is the first maxBytes of a longer response (only with `truncate`). */
  truncated: boolean;
  text(): string;
}

/** A response other than 200, with its status. */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A response that must be the resource itself: anything but 200 is an error naming the status (and `what` was asked for). */
export function requireOk(res: GuardedResponse, what?: string): GuardedResponse {
  if (res.status !== 200) throw new HttpStatusError(res.status, what ? `HTTP ${res.status} for ${what}` : `HTTP ${res.status}`);
  return res;
}

/** How the collectors introduce themselves: the site's own crawler name and address (site/site.ts). */
export const DEFAULT_UA = `Mozilla/5.0 (compatible; ${SITE.crawlerName}; +${config.siteUrl}/about)`;

/** The language a source asked for (its config.acceptLanguage), replacing the default preference above. */
export const languageHeaders = (language: string | undefined): Record<string, string> => language ? { "accept-language": language } : {};

export async function guardedFetch(input: string, opts: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  // One budget includes DNS, every redirect and the body. Restarting it at each hop allowed a
  // nominal 20 s image request to occupy the API for minutes.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const route = opts.route ?? "egress";
  const configuredHost = hostOf(new URL(input));
  const privateHosts = opts.privateFeedHost && config.privateFeedHosts.includes(configuredHost) ? [configuredHost] : [];
  const check = (target: string) => withinDeadline(assertPublicUrl(target, config.allowPrivateNetworkFetch,
    proxied(new URL(target), route, privateHosts) ? egressResolver() : undefined, privateHosts), signal);
  let url = await check(input);
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const headers = new Headers({ "user-agent": DEFAULT_UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" });
  // Header names are case-insensitive: a caller's "User-Agent" replaces the default instead of joining it.
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
  const publicHeaders = new Set(["accept", "accept-language", "accept-encoding", "user-agent", "cache-control", "if-modified-since", "if-none-match", "range", "if-range"]);
  // Unknown custom headers and request bodies may carry credentials: the whole redirect chain keeps the first origin.
  const originBound = opts.redirectPolicy === "same-origin" || opts.body !== undefined || Object.keys(opts.headers ?? {}).some((name) => !publicHeaders.has(name.toLowerCase()));
  const initialOrigin = url.origin;
  let method = (opts.method ?? "GET").toUpperCase();
  let requestBody = opts.body;
  for (let hop = 0; ; hop++) {
    const viaProxy = proxied(url, route, privateHosts);
    const privateHost = privateHosts.includes(hostOf(url));
    const send = (dispatcher: Dispatcher | undefined) => undiciFetch(url, {
      method,
      headers: Object.fromEntries(headers),
      body: requestBody,
      redirect: "manual",
      dispatcher,
      signal,
    });
    const res = await send(dispatcherFor(viaProxy, privateHost)).catch(async (error: unknown) => {
      // Only a direct connection has a curve of its own to change, and only while the budget lasts:
      // a retry on an aborted signal fails the same way and hides the original error.
      const pinned = viaProxy || privateHost || signal.aborted || !brokenHandshake(error) ? undefined : pinnedCurveAgent();
      if (!pinned) throw error;
      return send(pinned);
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
      // Release the connection even when the next URL is refused or the redirect limit is reached.
      await res.body?.cancel();
      if (hop >= maxRedirects) throw new Error("Too many redirects");
      const next = new URL(res.headers.get("location")!, url);
      if (originBound && next.origin !== initialOrigin) throw new Error("Blocked cross-origin redirect for a protected request");
      url = await check(next.toString());
      if (((res.status === 301 || res.status === 302) && method === "POST") || (res.status === 303 && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        requestBody = undefined;
        for (const name of ["content-encoding", "content-language", "content-location", "content-type", "content-length"]) headers.delete(name);
      }
      continue;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (size + chunk.byteLength > maxBytes) {
          if (!opts.truncate) throw new Error(`Response too large from ${url.hostname}`);
          // Leaving the loop cancels the rest of the body.
          chunks.push(Buffer.from(chunk.subarray(0, maxBytes - size)));
          truncated = true;
          break;
        }
        size += chunk.byteLength;
        chunks.push(Buffer.from(chunk));
      }
    }
    const body = Buffer.concat(chunks);
    return {
      status: res.status,
      url: url.toString(),
      headers: res.headers as unknown as Headers,
      body,
      truncated,
      text: () => decodeBody(body, res.headers.get("content-type")),
    };
  }
}

/** DNS lookup cannot be cancelled, but a timed-out lookup must never continue into a fetch. */
async function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let subscription: ReturnType<typeof addAbortListener> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      subscription = addAbortListener(signal, () => reject(signal.reason));
    })]);
  } finally {
    subscription?.[Symbol.dispose]();
  }
}

function decodeBody(body: Buffer, contentType: string | null): string {
  // A media-type parameter may be a quoted string: charset="gb2312".
  const m = /charset="?([\w-]+)/i.exec(contentType ?? "");
  let charset = m?.[1]?.toLowerCase() ?? "utf-8";
  if (!m) {
    const head = body.subarray(0, 2048).toString("latin1");
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ?? /encoding=["']([\w-]+)["']/i.exec(head);
    if (meta) charset = meta[1]!.toLowerCase();
  }
  let text: string;
  try {
    text = new TextDecoder(charset === "gb2312" ? "gbk" : charset).decode(body);
  } catch {
    text = body.toString("utf8");
  }
  // NUL cannot be represented in PostgreSQL text or JSONB, including received paid responses.
  // Keep the original body bytes; decoded text uses the same replacement as malformed bytes.
  // A character lost on the way reads as one U+FFFD however many of its bytes were garbled (some
  // feeds send two or three for one character), so text cut to a length keeps the same cut.
  return text.replace(/\u0000/g, "\uFFFD").replace(/\uFFFD+/g, "\uFFFD");
}
