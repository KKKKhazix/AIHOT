// Image fetch, resize and cache, shared by the signed image proxy and the vision analysis: a (mode, url)
// is fetched once through the egress route and both get the same file.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.ts";
import { guardedFetch, type GuardedResponse } from "../lib/http-fetch.ts";
import { IMAGE_WIDTHS } from "./renditions.ts";

const CACHE_DIR = path.join(config.dataDir, "imgcache");
const ORIGINAL_TTL_MS = 60_000;
const ORIGINAL_MAX_BYTES = 32 * 1024 * 1024;
const ORIGINAL_MAX_ENTRIES = 32;
const recentOriginals = new Map<string, { value: GuardedResponse; until: number }>();
let originalBytes = 0;
export interface PreparedImage {
  body: Buffer;
  type: string;
  /** A GIF awaiting background conversion must not hide its replacement behind a multi-day cache. */
  pendingAnimation?: boolean;
}
const inflight = new Map<string, Promise<PreparedImage>>();
const originals = new Map<string, Promise<GuardedResponse>>();
const failures = new Map<string, { until: number; error: unknown }>();

// Responsive candidates and a later lightbox can request the same source in successive turns.
// Keep at most 32 MiB / 32 originals for one minute as well as sharing in-flight downloads.
function pruneOriginals(now: number): void {
  for (const [url, entry] of recentOriginals) {
    if (entry.until <= now) {
      originalBytes -= entry.value.body.length;
      recentOriginals.delete(url);
    }
  }
}

function rememberOriginal(url: string, value: GuardedResponse): void {
  const now = Date.now();
  pruneOriginals(now);
  if (value.body.length > ORIGINAL_MAX_BYTES) return;
  while (recentOriginals.size >= ORIGINAL_MAX_ENTRIES || originalBytes + value.body.length > ORIGINAL_MAX_BYTES) {
    const first = recentOriginals.keys().next().value!;
    originalBytes -= recentOriginals.get(first)!.value.body.length;
    recentOriginals.delete(first);
  }
  recentOriginals.set(url, { value, until: now + ORIGINAL_TTL_MS });
  originalBytes += value.body.length;
}
function original(url: string): Promise<GuardedResponse> {
  pruneOriginals(Date.now());
  const recent = recentOriginals.get(url);
  if (recent) {
    recentOriginals.delete(url);
    recentOriginals.set(url, recent);
    return Promise.resolve(recent.value);
  }
  const failed = failures.get(url);
  if (failed && failed.until > Date.now()) return Promise.reject(failed.error);
  failures.delete(url);
  let job = originals.get(url);
  if (!job) {
    job = fetchOriginal(url).then((res) => {
      rememberOriginal(url, res);
      return res;
    }).catch((error: unknown) => {
      // A failed original is not refetched for a minute; this also coalesces failures across signed modes.
      failures.set(url, { until: Date.now() + 60_000, error });
      if (failures.size > 512) failures.delete(failures.keys().next().value!);
      throw error;
    }).finally(() => originals.delete(url));
    originals.set(url, job);
  }
  return job;
}

async function fetchOriginal(url: string): Promise<GuardedResponse> {
  const res = await guardedFetch(url, {
    timeoutMs: 20_000, maxBytes: 15 * 1024 * 1024, headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
  });
  if (res.status !== 200) throw new Error(`upstream ${res.status}`);
  return res;
}

/**
 * The largest picture in a Windows icon (favicon.ico), as something sharp reads: PNG entries as they
 * are, 32- and 24-bit bitmap entries as raw RGBA. Other depths are skipped.
 */
export function decodeIco(buf: Buffer): Buffer | { raw: Buffer; width: number; height: number } | null {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const entries = Array.from({ length: buf.readUInt16LE(4) }, (_, i) => 6 + i * 16)
    .filter((at) => at + 16 <= buf.length)
    .map((at) => ({ size: buf[at] || 256, bytes: buf.readUInt32LE(at + 8), offset: buf.readUInt32LE(at + 12) }))
    .filter((e) => e.offset + e.bytes <= buf.length)
    .sort((a, b) => b.size - a.size);
  for (const e of entries) {
    const data = buf.subarray(e.offset, e.offset + e.bytes);
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return Buffer.from(data);
    if (data.length < 40) continue;
    const width = data.readInt32LE(4);
    const height = Math.abs(data.readInt32LE(8)) / 2;
    const bits = data.readUInt16LE(14);
    if ((bits !== 32 && bits !== 24) || width <= 0 || height <= 0) continue;
    const stride = Math.ceil((width * bits) / 32) * 4;
    const pixels = data.subarray(data.readUInt32LE(0));
    if (pixels.length < stride * height) continue;
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const row = pixels.subarray((height - 1 - y) * stride);
      for (let x = 0; x < width; x++) {
        const p = x * (bits / 8);
        const o = (y * width + x) * 4;
        raw[o] = row[p + 2]!;
        raw[o + 1] = row[p + 1]!;
        raw[o + 2] = row[p]!;
        raw[o + 3] = bits === 32 ? row[p + 3]! : 255;
      }
    }
    return { raw, width, height };
  }
  return null;
}

/** The cached rendition of an image for a mode, fetched and resized on first use. */
export function produceImage(url: string, mode: string): Promise<PreparedImage> {
  const key = `${mode}|${url}`;
  let job = inflight.get(key);
  if (!job) {
    job = produce(url, mode).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

function cacheFile(url: string, mode: string): string {
  const key = createHash("sha256").update(`${mode}|${url}`).digest("hex");
  return path.join(CACHE_DIR, key.slice(0, 2), key);
}

async function cachedImage(file: string, body: Buffer, type: string): Promise<PreparedImage> {
  if (type !== "image/gif") return { body, type };
  const prepared = await readFile(`${file}.prepared`).then(() => true, () => false);
  if (prepared) return { body, type };
  const meta = await sharp(body, { animated: true, limitInputPixels: false }).metadata();
  const pixels = (meta.width ?? 0) * (meta.pageHeight ?? 0) * (meta.pages ?? 1);
  // Unsupported large animations are kept as-is; shortening their cache would only add traffic.
  return { body, type, ...(pixels > 0 && pixels <= ANIMATION_MAX_PIXELS ? { pendingAnimation: true } : {}) };
}

async function produce(url: string, mode: string): Promise<PreparedImage> {
  const file = cacheFile(url, mode);
  try {
    const [body, meta] = await Promise.all([readFile(file), readFile(`${file}.type`, "utf8")]);
    return cachedImage(file, body, meta);
  } catch {
    // not cached
  }
  const res = await original(url);
  const image = await resizeImage(res.body, res.headers.get("content-type") ?? "", mode);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, image.body);
  await writeFile(`${file}.type`, image.type);
  return cachedImage(file, image.body, image.type);
}

/** Most frames × pixels an animation may have to be re-encoded (all frames are decoded at once). */
const ANIMATION_MAX_PIXELS = 200_000_000;

/**
 * Replaces a cached animated rendition (GIF passed through on the request path) with an animated
 * WebP at the rendition's width, keeping every frame, its timing and the loop count, when that is
 * clearly smaller. Background work only (media.prepare): decoding all frames is too heavy for a
 * request. Returns the bytes saved (0 when nothing changed).
 */
export async function convertAnimated(url: string, mode: string): Promise<number> {
  const file = cacheFile(url, mode);
  const [body, type] = await Promise.all([readFile(file).catch(() => null), readFile(`${file}.type`, "utf8").catch(() => null)]);
  if (!body || type !== "image/gif") return 0;
  if (await readFile(`${file}.prepared`).then(() => true, () => false)) return 0;
  const meta = await sharp(body, { animated: true, limitInputPixels: false }).metadata();
  const frames = meta.pages ?? 1;
  if (!meta.width || !meta.pageHeight || meta.width * meta.pageHeight * frames > ANIMATION_MAX_PIXELS) return 0;
  const width = IMAGE_WIDTHS[mode as keyof typeof IMAGE_WIDTHS] ?? 1600;
  const webp = await sharp(body, { animated: true, limitInputPixels: ANIMATION_MAX_PIXELS })
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 80, effort: 4, loop: meta.loop ?? 0, ...(meta.delay ? { delay: meta.delay } : {}) })
    .toBuffer().catch(() => null);
  if (!webp || webp.length > body.length * 0.85) {
    // Preparation finished, but this GIF cannot be converted or the original is smaller.
    // Keep it normally cached instead of repeatedly queueing the same immutable source.
    await writeFile(`${file}.prepared`, "original");
    return 0;
  }
  // A deploy can briefly overlap worker processes; neither may rename the other's temp files.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, webp);
  await writeFile(`${tmp}.type`, "image/webp");
  await rename(tmp, file);
  await rename(`${tmp}.type`, `${file}.type`);
  return body.length - webp.length;
}

/** Deterministic output for a signed rendition: the request's Accept header never changes the bytes. */
export async function resizeImage(body: Buffer, upstreamType: string, mode: string): Promise<{ body: Buffer; type: string }> {
  const ico = decodeIco(body);
  const suppliedType = upstreamType.split(";")[0]!.trim().toLowerCase();
  // Google Storage serves some real WebP images as generic binary. Decode their metadata before
  // accepting them; a missing MIME type must not turn HTML/error pages into successful images.
  const binary = suppliedType === "application/octet-stream" || suppliedType === "binary/octet-stream" || suppliedType === "";
  if (!suppliedType.startsWith("image/") && !ico && !binary) throw new Error("upstream is not an image");
  let type = ico ? "image/png" : suppliedType;
  if (/icon$/.test(type) && !ico) throw new Error("unreadable icon");
  const avatar = mode === "avatar" || mode.startsWith("avatar-");
  const width = IMAGE_WIDTHS[mode as keyof typeof IMAGE_WIDTHS] ?? 1600;
  const raw = ico && !Buffer.isBuffer(ico) ? { raw: { width: ico.width, height: ico.height, channels: 4 as const } } : {};
  const input = ico && !Buffer.isBuffer(ico) ? ico.raw : ico ?? body;
  const meta = await sharp(input, { ...raw, failOn: "none" }).metadata();
  if (binary && !ico) {
    if (!meta.mediaType?.startsWith("image/")) throw new Error("upstream is not an image");
    type = meta.mediaType;
  }
  // A large animation can be hundreds of frames: do not silently replace it with a still or decode
  // all its frames on an HTTP request. Keep frame timing, loop count and transparency unchanged.
  if ((meta.pages ?? 1) > 1 || type === "image/gif") return { body, type };
  // Small vectors are already compact and remain sharp at every zoom level. Rasterize oversized
  // SVGs (often screenshots embedded as base64) and avatars at their actual display rendition.
  if (type === "image/svg+xml" && !avatar && body.length <= 128 * 1024) return { body, type };
  const density = type === "image/svg+xml" && meta.width ? Math.max(72, Math.min(300, Math.ceil(width / meta.width * 72))) : 72;
  let image = sharp(input, { ...raw, failOn: "none", density }).rotate();
  image = avatar ? image.resize(width, width, { fit: "cover" }) : image.resize({ width, withoutEnlargement: true });
  // Screenshots and transparent PNGs benefit most from modern encoding. Already lossy JPEGs
  // measured larger at WebP 88, so retain their established encoder/quality instead of growing them.
  if (ico || type === "image/png" || type === "image/svg+xml") {
    return { body: await image.webp({ quality: 88, alphaQuality: 100, smartSubsample: true, effort: 4 }).toBuffer(), type: "image/webp" };
  }
  if (type === "image/webp") return { body: await image.webp({ quality: 82 }).toBuffer(), type };
  return { body: await image.jpeg({ quality: 82, mozjpeg: true }).toBuffer(), type: "image/jpeg" };
}
