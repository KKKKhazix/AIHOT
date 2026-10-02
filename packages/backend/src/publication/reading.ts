import * as cheerio from "cheerio";
import { config } from "../config.ts";
import { storyReportCondition } from "./scope.ts";
import { sql } from "../db.ts";
import { readingAssetImage } from "../media/reading-images.ts";
import type { BodyBlock } from "../content/blocks.ts";
import type { ImageRow } from "../content/reading.ts";

export function snapshotPostImages(articleId: string, value: unknown, images: ImageRow[]): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const post = value as Record<string, any>;
  const assets = new Map(images.filter((i) => i.status === "read" && i.asset_hash).map((i) => [i.url, i.asset_hash]));
  const media = (items: Array<Record<string, any>> = []) => items.flatMap((m) => m.kind !== "image" ? [m] :
    assets.has(m.url) ? [{ ...m, url: `${config.siteUrl}/api/site/items/${encodeURIComponent(articleId)}/body-images/${assets.get(m.url)}` }] : []);
  return { ...post, media: media(post.media), ...(post.quoted ? { quoted: { ...post.quoted, media: media(post.quoted.media) } } : {}) };
}

/** Store stable snapshot URLs, so a source replacing a price image cannot change a released body. */
export function snapshotBodyImages(articleId: string, html: string, blocks: BodyBlock[], images: ImageRow[]): string {
  const queues = new Map<string, string[]>();
  const byId = new Map(images.map((i) => [i.image_id, i]));
  for (const b of blocks) {
    const i = byId.get(b.id);
    if (i?.status !== "read" || !i.asset_hash) continue;
    const paths = queues.get(i.url) ?? [];
    paths.push(`${config.siteUrl}/api/site/items/${encodeURIComponent(articleId)}/body-images/${i.asset_hash}`);
    queues.set(i.url, paths);
  }
  const $ = cheerio.load(html, null, false);
  $("img[src]").each((_, node) => {
    const image = $(node);
    const paths = queues.get(image.attr("src")!);
    const src = paths && (paths.length > 1 ? paths.shift() : paths[0]);
    if (src) image.attr("src", src);
    else image.remove(); // Never release a mutable source image with no accepted snapshot.
  });
  return $.html();
}

/** Every published image, including historical versions, remains behind current source permissions. */
export async function publishedReadingImage(articleId: string, hash: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const [found] = await sql`SELECT 1 FROM publications p JOIN sources s ON s.id = p.source_id
    JOIN article_readings r ON r.article_id = p.article_id JOIN article_image_readings i ON i.reading_id = r.id
    WHERE p.article_id = ${articleId} AND ${storyReportCondition(new Date())} AND p.body_mode = 'full'
      AND s.site_fulltext AND r.published_at IS NOT NULL
      AND i.asset_hash = ${hash} AND i.status = 'read' LIMIT 1`;
  return found ? readingAssetImage(hash) : null;
}
