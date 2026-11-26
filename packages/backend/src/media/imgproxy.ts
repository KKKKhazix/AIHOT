// Signed image proxy URLs. The address format and signing key stay stable, so proxy URLs
// already cached in full RSS and readers keep working: /api/img-proxy?u=&mode=&exp=&sig=
// sig = hex(HMAC-SHA256(IMG_PROXY_SIGN_SECRET, `${u}|${mode}|${exp}`)), sent as its first 16 hex
// digits (64 bits): the random digits cannot be compressed, and the full 64 made up about a tenth
// of a compressed list page. A full-length signature from an older URL is still accepted. A mode with
// the AVIF suffix (card-avif) is that rendition's AVIF variant and carries the rendition's signature.
import { createHmac, timingSafeEqual } from "node:crypto";
import * as cheerio from "cheerio";
import { config, credential } from "../config.ts";
import { normalizeVideos } from "../content/video.ts";
import { isNonArticleImage } from "../lib/image-url.ts";
import { isXVideoUrl } from "../lib/video-url.ts";
import { AVIF_MODE_SUFFIX } from "@aihot/contracts/site";
import { AVIF_MODES, IMAGE_WIDTHS, RESPONSIVE_MODES, type ProxyMode, type ResponsiveImageKind } from "./renditions.ts";
export type { ProxyMode } from "./renditions.ts";

// A URL keeps its expiry for a whole day, so the edge and browsers can reuse one copy of an image all
// day; it stays valid for two to three days. Avatars (source icons and authors' pictures) are a small
// set that appears on every visit: they keep one address for 30 days, so a returning reader's browser
// still has them instead of downloading them again each day.
const WINDOW_SECONDS = 24 * 3600;
const AVATAR_WINDOW_SECONDS = 30 * 24 * 3600;
const LIFETIME_SECONDS = 48 * 3600;
const SIG_HEX = 16;
export const GIF_VIDEO_MODE = "gif-video";
export const X_VIDEO_MODE = "x-video";
/** How long browsers and the edge may keep a proxied image: as long as an avatar keeps its address. */
export const LONGEST_CACHE_SECONDS = AVATAR_WINDOW_SECONDS;

function secret(): string {
  const s = credential("auth", "IMG_PROXY_SIGN_SECRET");
  if (!s) throw new Error("IMG_PROXY_SIGN_SECRET is not configured");
  return s;
}

export function signature(url: string, mode: string, exp: number | string): string {
  return createHmac("sha256", secret()).update(`${url}|${mode}|${exp}`).digest("hex").slice(0, SIG_HEX);
}

/** Expiry rounded up to a window boundary at least `lifetime` (48 h) ahead, so URLs stay cacheable. */
function proxyExpiry(nowMs: number, lifetimeSeconds: number, windowSeconds: number): number {
  return Math.ceil((nowMs / 1000 + lifetimeSeconds) / windowSeconds) * windowSeconds;
}

export function proxiedImage(url: string | null | undefined, mode: ProxyMode, absolute = false, nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): string | null {
  if (!url) return null;
  if (isNonArticleImage(url)) return null;
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  const exp = proxyExpiry(nowMs, lifetimeSeconds, (RESPONSIVE_MODES.avatar as readonly ProxyMode[]).includes(mode) ? AVATAR_WINDOW_SECONDS : WINDOW_SECONDS);
  return signedMediaUrl(url, mode, exp, absolute);
}

function signedMediaUrl(url: string, mode: string, exp: number, absolute: boolean): string {
  const path = `/api/img-proxy?u=${encodeURIComponent(url)}&mode=${mode}&exp=${exp}&sig=${signature(url, mode, exp)}`;
  return absolute ? `${config.siteUrl}${path}` : path;
}

/** Browser source candidates, each independently signed with the same expiry boundary. */
export function proxiedImageSet(url: string | null | undefined, kind: ResponsiveImageKind, absolute = false, nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): string | null {
  if (!url || !/^https?:\/\//i.test(url) || isNonArticleImage(url)) return null;
  return RESPONSIVE_MODES[kind].map((mode) => `${proxiedImage(url, mode, absolute, nowMs, lifetimeSeconds)} ${IMAGE_WIDTHS[mode]}w`).join(", ");
}

export type VerifyResult = { ok: true; url: string; mode: string; avif: boolean } | { ok: false; reason: "missing" | "expired" | "bad-signature" | "bad-url" };

export function verifyProxyRequest(params: { u?: string; mode?: string; exp?: string; sig?: string }, nowMs = Date.now()): VerifyResult {
  const { u, mode, exp, sig } = params;
  if (!u || !mode || !exp || !sig) return { ok: false, reason: "missing" };
  if (!/^\d{9,11}$/.test(exp)) return { ok: false, reason: "missing" };
  if (Number(exp) * 1000 < nowMs) return { ok: false, reason: "expired" };
  if (!/^https?:\/\//i.test(u)) return { ok: false, reason: "bad-url" };
  const avif = mode.endsWith(AVIF_MODE_SUFFIX);
  const rendition = avif ? mode.slice(0, -AVIF_MODE_SUFFIX.length) : mode;
  if (rendition === X_VIDEO_MODE && !isXVideoUrl(u)) return { ok: false, reason: "bad-url" };
  if (avif && !(AVIF_MODES as readonly string[]).includes(rendition)) return { ok: false, reason: "bad-signature" };
  const given = Buffer.from(new RegExp(`^[0-9a-f]{${SIG_HEX}}$`, "i").test(sig) ? sig : "", "hex");
  const expected = Buffer.from(signature(u, rendition, exp), "hex");
  if (given.length === 0 || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-signature" };
  return { ok: true, url: u, mode: rendition, avif };
}

/**
 * Rewrites images, video posters and X MP4s in safe body HTML to signed proxy URLs. Feed readers keep
 * items for days, so full RSS asks for a longer signature than a page.
 */
export function proxyBodyImages(html: string, absolute = false, lifetimeSeconds = LIFETIME_SECONDS): string {
  if (!/<(?:img|video)\b/i.test(html)) return html;
  const now = Date.now();
  const $ = cheerio.load(html, null, false);
  const exp = proxyExpiry(now, lifetimeSeconds, WINDOW_SECONDS);
  $("video[poster]").each((_, el) => {
    const video = $(el);
    const poster = proxiedImage(video.attr("poster"), "thumb", absolute, now, lifetimeSeconds);
    if (poster) video.attr("poster", poster);
    else video.removeAttr("poster");
  });
  $("video[src], video > source[src]").each((_, el) => {
    const source = $(el);
    const url = source.attr("src")!;
    if (isXVideoUrl(url)) source.attr("src", signedMediaUrl(url, X_VIDEO_MODE, exp, absolute));
  });
  normalizeVideos($);
  $("img[src]").each((_, el) => {
    const img = $(el);
    const url = img.attr("src")!;
    if (isNonArticleImage(url, img.attr("width"), img.attr("height"))) {
      img.remove();
      return;
    }
    const preview = proxiedImage(url, absolute ? "full" : "reading", absolute, now, lifetimeSeconds);
    if (!preview) {
      img.removeAttr("src");
      return;
    }
    img.removeAttr("srcset sizes").attr({ src: preview, loading: "lazy", decoding: "async" });
    if (absolute || url.startsWith("data:")) return;
    if (img.parents("a").length) return;
    if (isGifUrl(url)) {
      const player = $("<video></video>").attr({
        poster: preview, src: signedMediaUrl(url, GIF_VIDEO_MODE, exp, false),
        controls: "", playsinline: "", preload: "none", "data-full-sig": signature(url, "full", exp),
      });
      for (const name of ["width", "height", "aria-label"] as const) {
        const value = img.attr(name === "aria-label" ? "alt" : name);
        if (value) player.attr(name, value);
      }
      (img.parent().is("picture") ? img.parent() : img).replaceWith(player);
    } else {
      // The viewer builds the full URL only on activation; bulk image fetchers see one src.
      img.attr("data-full-sig", signature(url, "full", exp));
    }
  });
  return $.html();
}

export function isGifUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const source = new URL(url);
  return /\.gif$/i.test(source.pathname) || source.searchParams.get("format") === "gif";
}
