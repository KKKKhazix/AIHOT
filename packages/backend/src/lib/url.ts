// URL normalisation for material identity, and the fetcher's network guard.
import { lookup } from "node:dns/promises";
import net from "node:net";

const TRACKING_PARAMS = /^(utm_[a-z]+|spm|from|ref|ref_src|ref_url|source|share_source|share_token|fbclid|gclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|scene|chksm|sessionid|srcid|clicktime|enterid|mkt_tok)$/i;

/** Canonical form used for identity: lower-case host, no fragment, no tracking params, no trailing slash. */
export function normalizeUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  u.protocol = "https:";
  if (u.port === "443" || u.port === "80") u.port = "";
  // WeChat articles are identified by __biz/mid/idx/sn only.
  if (u.hostname === "mp.weixin.qq.com") {
    const keep = ["__biz", "mid", "idx", "sn"];
    const params = new URLSearchParams();
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v) params.set(k, v);
    }
    u.search = params.toString();
  } else {
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
  }
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s;
}

/** Tweet id from an x.com / twitter.com status URL. */
export function tweetIdFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!/^(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com$/.test(u.hostname)) return null;
  const m = /^\/[^/]+\/status(?:es)?\/(\d+)(?:\/|$)/i.exec(u.pathname);
  return m ? m[1]! : null;
}

/**
 * Identity of material at an address. `keepFragment` is for sources whose entries are sections of one
 * page (release notes: overview#september-24-2026): without it every section is the same article.
 */
export function identityKeyForUrl(url: string, opts: { keepFragment?: boolean } = {}): string | null {
  const tweet = tweetIdFromUrl(url);
  if (tweet) return `x:${tweet}`;
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const fragment = opts.keepFragment ? new URL(url.trim()).hash : "";
  return `url:${normalized}${fragment.length > 1 ? fragment : ""}`;
}

function ipv4Blocked(o: [number, number, number, number]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast and reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // TEST-NET-2/3
    // 198.18.0.0/15 stays allowed: fake-IP resolvers of local proxies (development machines) answer
    // from it; nothing on the production host listens there.
  );
}

function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const o = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return o.every((n) => n >= 0 && n <= 255) ? (o as [number, number, number, number]) : null;
}

/** The eight 16-bit groups of an IPv6 address (accepts "::" and a trailing dotted IPv4). */
function ipv6Groups(s: string): number[] | null {
  let text = s.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]!);
    if (!v4) return null;
    text = `${text.slice(0, -dotted[1]!.length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

function embeddedIpv4(hi: number, lo: number): [number, number, number, number] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * True when an address must never be fetched: loopback, private, link-local, metadata, multicast,
 * reserved and documentation ranges, including IPv4 addresses carried inside IPv6 (mapped,
 * compatible, NAT64, 6to4) and Teredo, whose real endpoint cannot be judged.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return ipv4Blocked(v4);
  const g = ipv6Groups(address);
  if (!g) return true; // not an address we understand: refuse
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff || g5 === 0) {
      // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), :: and ::1.
      if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
      return ipv4Blocked(embeddedIpv4(g6, g7));
    }
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Blocked(embeddedIpv4(g6, g7)); // NAT64
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // local-use NAT64
  if (g0 === 0x2002) return ipv4Blocked(embeddedIpv4(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard prefix
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

function ipv4Internal(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * True when an address reaches this host or a private network: loopback, unspecified, private,
 * carrier-grade NAT, link-local and metadata, unique-local and site-local, also inside IPv6 (mapped,
 * compatible, NAT64, 6to4). The narrower check for names the egress proxy resolves itself: a poisoned
 * local answer (Teredo, documentation, reserved) says nothing about where the proxy will connect.
 */
export function isInternalAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return ipv4Internal(v4);
  const g = ipv6Groups(address);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
    return ipv4Internal(embeddedIpv4(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Internal(embeddedIpv4(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  if (g0 === 0x2002) return ipv4Internal(embeddedIpv4(g1, g2));
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0;
}

function blockedHostname(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host === "metadata.google.internal";
}

/**
 * Rejects URLs that name or resolve to loopback, private, link-local or cloud-metadata addresses
 * (SSRF guard). A direct request is checked again at connect time, so a second DNS answer cannot slip
 * past. A name sent through the egress proxy (`proxied`) is resolved and dialled abroad, so only an
 * internal local answer refuses it: the local resolver's poisoned answers for blocked sites (Teredo and
 * other unroutable addresses) would otherwise refuse them. Only local debugging may disable the guard
 * via ALLOW_PRIVATE_NETWORK_FETCH.
 */
export async function assertPublicUrl(url: string, allowPrivate = false, proxied = false): Promise<URL> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Blocked protocol ${u.protocol}`);
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (blockedHostname(host)) throw new Error(`Blocked host ${host}`);
  const literal = net.isIP(host) !== 0;
  const addresses = literal ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error(`No address for ${host}`);
  const refused = proxied && !literal ? isInternalAddress : isBlockedAddress;
  for (const { address } of addresses) {
    if (refused(address)) throw new Error(`Blocked private address for ${host}`);
  }
  return u;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/**
 * DNS lookup for outbound sockets that refuses blocked addresses. Used as the connect-time lookup,
 * it closes the gap between the URL check and the connection (DNS rebinding).
 */
export function guardedLookup(hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback): void {
  const opts = typeof options === "number" ? { family: options } : options;
  if (blockedHostname(hostname.toLowerCase())) {
    callback(Object.assign(new Error(`Blocked host ${hostname}`), { code: "EBLOCKED" }), opts.all ? [] : "", 0);
    return;
  }
  lookup(hostname, { all: true, family: opts.family ?? 0 }).then(
    (list) => {
      const bad = list.find((a) => isBlockedAddress(a.address));
      if (bad || list.length === 0) {
        callback(Object.assign(new Error(`Blocked private address for ${hostname}`), { code: "EBLOCKED" }), opts.all ? [] : "", 0);
        return;
      }
      if (opts.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    },
    (err: NodeJS.ErrnoException) => callback(err, opts.all ? [] : "", 0),
  );
}
