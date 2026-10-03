// Outbound HTTP for collectors, the image proxy and the paid APIs: SSRF guard, routing, limits.
import net from "node:net";
import { addAbortListener } from "node:events";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { config } from "../config.ts";
import { assertPublicUrl, guardedLookup } from "./url.ts";
import { createEgressProxy, createEgressResolver } from "./egress-proxy.ts";
import { SITE } from "@aihot/site";

/**
 * Where a request leaves the host. "egress" (collection, bodies, images and other public data) goes
 * through the egress proxy when EGRESS_PROXY_URL is set (for example a rule-based proxy that connects
 * .cn and .local names and Chinese or private addresses directly and sends the rest abroad); the names
 * and address literals such a proxy would connect directly are connected here instead, so the
 * connect-time address check still applies. A name sent through the proxy is resolved through it too
 * (egress-proxy.ts), and the tunnel goes to the checked address. "direct" is for paid APIs called
 * straight (SocialData, Dajiala) and the site's own addresses.
 */
export type EgressRoute = "egress" | "direct";

let proxyAgent: ProxyAgent | null = null;
let directAgent: Agent | null = null;
let resolveEgress: ReturnType<typeof createEgressResolver> | null = null;

function egressResolver() {
  return resolveEgress ??= createEgressResolver(config.egressProxyUrl!);
}

function proxied(url: URL, route: EgressRoute): boolean {
  if (route !== "egress" || !config.egressProxyUrl) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return net.isIP(host) === 0 && !host.endsWith(".cn") && !host.endsWith(".local");
}

function dispatcherFor(viaProxy: boolean): Dispatcher | undefined {
  if (viaProxy) {
    proxyAgent ??= createEgressProxy(config.egressProxyUrl!, egressResolver());
    return proxyAgent;
  }
  if (config.allowPrivateNetworkFetch) return undefined;
  // Direct connections resolve through the guarded lookup: the address actually dialled is checked.
  directAgent ??= new Agent({ connect: { lookup: guardedLookup as never } });
  return directAgent;
}

export interface GuardedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Follow redirects manually so every hop passes the SSRF guard. */
  maxRedirects?: number;
  /** Keeps every hop on the original origin when the URL itself may carry credentials (never relaxes the automatic rule). */
  redirectPolicy?: "same-origin";
  /** "egress" by default; see EgressRoute. */
  route?: EgressRoute;
}

export interface GuardedResponse {
  status: number;
  url: string;
  headers: Headers;
  body: Buffer;
  text(): string;
}

/** How the collectors introduce themselves: the site's own crawler name and address (site/site.ts). */
export const DEFAULT_UA = `Mozilla/5.0 (compatible; ${SITE.crawlerName}; +${config.siteUrl}/about)`;

export async function guardedFetch(input: string, opts: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  // One budget includes DNS, every redirect and the body. Restarting it at each hop allowed a
  // nominal 20 s image request to occupy the API for minutes.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const route = opts.route ?? "egress";
  const check = (target: string) => withinDeadline(assertPublicUrl(target, config.allowPrivateNetworkFetch,
    proxied(new URL(target), route) ? egressResolver() : undefined), signal);
  let url = await check(input);
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const headers = new Headers({ "user-agent": DEFAULT_UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", ...(opts.headers ?? {}) });
  const publicHeaders = new Set(["accept", "accept-language", "accept-encoding", "user-agent", "cache-control", "if-modified-since", "if-none-match", "range", "if-range"]);
  // Unknown custom headers and request bodies may carry credentials: the whole redirect chain keeps the first origin.
  const originBound = opts.redirectPolicy === "same-origin" || opts.body !== undefined || Object.keys(opts.headers ?? {}).some((name) => !publicHeaders.has(name.toLowerCase()));
  const initialOrigin = url.origin;
  let method = (opts.method ?? "GET").toUpperCase();
  let requestBody = opts.body;
  for (let hop = 0; ; hop++) {
    const res = await undiciFetch(url, {
      method,
      headers: Object.fromEntries(headers),
      body: requestBody,
      redirect: "manual",
      dispatcher: dispatcherFor(proxied(url, route)),
      signal,
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
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error(`Response too large from ${url.hostname}`);
        chunks.push(Buffer.from(chunk));
      }
    }
    const body = Buffer.concat(chunks);
    return {
      status: res.status,
      url: url.toString(),
      headers: res.headers as unknown as Headers,
      body,
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
  const m = /charset=([\w-]+)/i.exec(contentType ?? "");
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
  // A character lost on the way reads as one U+FFFD however many of its bytes were garbled (some
  // feeds send two or three for one character), so text cut to a length keeps the same cut.
  return text.replace(/\uFFFD+/g, "\uFFFD");
}
