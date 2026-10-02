// Immutable reading evidence is separate from URL-keyed display caches.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { sha256 } from "../lib/ids.ts";
import { READING_POLICY as P } from "../content/reading-config.ts";
import type { ContentPart } from "../providers/llm.ts";

export interface ReadingAsset {
  hash: string;
  etag: string | null;
  lastModified: string | null;
  tiles: Array<{ part: ContentPart; region: { left: number; top: number; width: number; height: number } }>;
}

export class ReadingImageDownloadError extends Error {}

function assetPath(hash: string, display = false): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid reading asset hash");
  return path.join(config.dataDir, "body-assets", hash.slice(0, 2), `${hash}${display ? ".webp" : ".original"}`);
}

export async function readingAssetImage(hash: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  return readFile(assetPath(hash, true)).catch(() => null);
}

/** Every new reading revalidates the source; retries of settled images use their stored evidence. */
export async function fetchReadingImage(url: string, previous?: { hash: string; etag: string | null; lastModified: string | null }): Promise<ReadingAsset> {
  const cached = previous ? await readFile(assetPath(previous.hash)).catch(() => null) : null;
  const headers: Record<string, string> = { accept: "image/png,image/jpeg,image/webp,image/*" };
  if (cached && previous?.etag) headers["if-none-match"] = previous.etag;
  else if (cached && previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 15 * 1024 * 1024, headers }).catch((error: unknown) => {
    if (error instanceof Error && /timeout|timed out|fetch failed|ECONNRESET|EAI_AGAIN/i.test(error.message)) throw new ReadingImageDownloadError(error.message);
    throw error;
  });
  if (res.status === 429 || res.status >= 500) throw new ReadingImageDownloadError(`图片下载暂时失败：HTTP ${res.status}`);
  if (res.status !== 200 && !(res.status === 304 && cached)) throw new Error(`图片下载失败：HTTP ${res.status}`);
  const bytes = res.status === 304 ? cached! : res.body;
  const hash = sha256(bytes);
  const metadata = await sharp(bytes, { limitInputPixels: P.maxPixels, failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp", "gif", "svg", "avif", "tiff"].includes(metadata.format ?? "")) throw new Error("图片格式无法读取");
  if ((metadata.pages ?? 1) > 1) throw new Error("多帧图片需要核对，不能只按首帧当作完整正文");
  const normalized = await sharp(bytes, { limitInputPixels: P.maxPixels, failOn: "error" }).rotate().png().toBuffer({ resolveWithObject: true });
  const { width, height } = normalized.info;
  const columns = width <= P.tileWidth ? 1 : Math.ceil((width - P.overlap) / (P.tileWidth - P.overlap));
  const rows = height <= P.tileHeight ? 1 : Math.ceil((height - P.overlap) / (P.tileHeight - P.overlap));
  const count = columns * rows;
  if (count > P.maxTilesPerImage) throw new Error(`图片超过 ${P.maxTilesPerImage} 个读取分段，需要单独核对`);
  const file = assetPath(hash);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const display = await sharp(bytes, { limitInputPixels: P.maxPixels }).rotate().webp({ lossless: true }).toBuffer();
  await writeFile(assetPath(hash, true), display, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const tiles: ReadingAsset["tiles"] = [];
  for (let i = 0; i < count; i++) {
    const top = Math.floor(i / columns) * (P.tileHeight - P.overlap);
    const left = (i % columns) * (P.tileWidth - P.overlap);
    const region = { left, top, width: Math.min(P.tileWidth, width - left), height: Math.min(P.tileHeight, height - top) };
    const tile = await sharp(normalized.data).extract(region).png().toBuffer();
    tiles.push({ region, part: { type: "image_url", image_url: { url: `data:image/png;base64,${tile.toString("base64")}` } } });
  }
  return { hash, tiles, etag: res.headers.get("etag") ?? (res.status === 304 ? previous?.etag ?? null : null),
    lastModified: res.headers.get("last-modified") ?? (res.status === 304 ? previous?.lastModified ?? null : null) };
}
