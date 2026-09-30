// Signed image proxy URLs. The address format and signing key stay stable, so proxy URLs
// already cached in full RSS and readers keep working: /api/img-proxy?u=&mode=&exp=&sig=
// sig = hex(HMAC-SHA256(IMG_PROXY_SIGN_SECRET, `${u}|${mode}|${exp}`)), sent as its first 16 hex
// digits (64 bits): the random digits cannot be compressed, and the full 64 made up about a tenth
// of a compressed list page. A full-length signature from an older URL is still accepted.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, credential } from "../config.ts";

import { IMAGE_WIDTHS, RESPONSIVE_MODES, type ProxyMode, type ResponsiveImageKind } from "./renditions.ts";
export type { ProxyMode } from "./renditions.ts";

// A URL keeps its expiry for a whole day, so the edge and browsers can reuse one copy of an image all
// day; it stays valid for two to three days.
const WINDOW_SECONDS = 24 * 3600;
const LIFETIME_SECONDS = 48 * 3600;
const SIG_HEX = 16;

function secret(): string {
  const s = credential("auth", "IMG_PROXY_SIGN_SECRET");
  if (!s) throw new Error("IMG_PROXY_SIGN_SECRET is not configured");
  return s;
}

export function signature(url: string, mode: string, exp: number | string): string {
  return createHmac("sha256", secret()).update(`${url}|${mode}|${exp}`).digest("hex");
}

/** Expiry rounded up to a day boundary at least `lifetime` (48 h) ahead, so URLs stay cacheable. */
export function proxyExpiry(nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): number {
  return Math.ceil((nowMs / 1000 + lifetimeSeconds) / WINDOW_SECONDS) * WINDOW_SECONDS;
}

export function proxiedImage(url: string | null | undefined, mode: ProxyMode, absolute = false, nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): string | null {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  const exp = proxyExpiry(nowMs, lifetimeSeconds);
  const path = `/api/img-proxy?u=${encodeURIComponent(url)}&mode=${mode}&exp=${exp}&sig=${signature(url, mode, exp).slice(0, SIG_HEX)}`;
  return absolute ? `${config.siteUrl}${path}` : path;
}

/** Browser source candidates, each independently signed with the same expiry boundary. */
export function proxiedImageSet(url: string | null | undefined, kind: ResponsiveImageKind, absolute = false, nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return RESPONSIVE_MODES[kind].map((mode) => `${proxiedImage(url, mode, absolute, nowMs, lifetimeSeconds)} ${IMAGE_WIDTHS[mode]}w`).join(", ");
}

export type VerifyResult = { ok: true; url: string; mode: string } | { ok: false; reason: "missing" | "expired" | "bad-signature" | "bad-url" };

export function verifyProxyRequest(params: { u?: string; mode?: string; exp?: string; sig?: string }, nowMs = Date.now()): VerifyResult {
  const { u, mode, exp, sig } = params;
  if (!u || mode === "" || !exp || !sig) return { ok: false, reason: "missing" };
  if (!/^\d{9,11}$/.test(exp)) return { ok: false, reason: "missing" };
  if (Number(exp) * 1000 < nowMs) return { ok: false, reason: "expired" };
  if (!/^https?:\/\//i.test(u)) return { ok: false, reason: "bad-url" };
  // Legacy article pages signed body images without a mode (as "default"); those still in open tabs and
  // caches keep loading, as full images, until their signature expires.
  const given = Buffer.from(new RegExp(`^(?:[0-9a-f]{${SIG_HEX}}|[0-9a-f]{64})$`, "i").test(sig) ? sig : "", "hex");
  const expected = Buffer.from(signature(u, mode ?? "default", exp), "hex").subarray(0, given.length);
  if (given.length === 0 || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-signature" };
  return { ok: true, url: u, mode: mode ?? "full" };
}

/**
 * Rewrites <img>/<video poster> sources in whitelisted body HTML to signed proxy URLs. Feed readers keep
 * items for days, so full RSS asks for a longer signature than a page.
 */
export function proxyBodyImages(html: string, absolute = false, lifetimeSeconds = LIFETIME_SECONDS): string {
  const now = Date.now();
  return html
    .replace(/<img\b([^>]*)>/gi, (tag: string, attrs: string) => {
      const src = attrs.match(/\ssrc="([^"]+)"/i);
      if (!src) return tag;
      const decoded = src[1]!.replace(/&amp;/g, "&");
      const proxied = proxiedImage(decoded, "full", absolute, now, lifetimeSeconds);
      // Width descriptors change an image's natural CSS size. Only use them for a body image with
      // an explicit display width: unknown and small pictures must retain their intrinsic size.
      // RSS keeps its existing single signed full image.
      const width = Number(attrs.match(/\bwidth="(\d+)"/i)?.[1] ?? 0);
      const candidates = !absolute && width >= IMAGE_WIDTHS["image-720"] ? proxiedImageSet(decoded, "body", false, now, lifetimeSeconds) : null;
      // `sizes=auto` adds size containment in Chrome: stale publisher width/height metadata then
      // overrides the loaded image's real ratio. Let intrinsic dimensions win after loading.
      const responsive = candidates ? ` srcset="${candidates.replace(/&/g, "&amp;")}" sizes="(min-width: 1536px) 760px, (min-width: 1024px) calc(100vw - 524px), (min-width: 640px) 608px, calc(100vw - 32px)"` : "";
      const source = proxied ? ` src="${proxied.replace(/&/g, "&amp;")}"${responsive} loading="lazy" decoding="async"` : "";
      return `<img${attrs.replace(src[0], source)}>`;
    })
    .replace(/<video\b([^>]*?)\sposter="([^"]+)"/gi, (_m, pre: string, src: string) => {
      const proxied = proxiedImage(src.replace(/&amp;/g, "&"), "thumb", absolute, now, lifetimeSeconds);
      return proxied ? `<video${pre} poster="${proxied.replace(/&/g, "&amp;")}"` : `<video${pre}`;
    });
}
