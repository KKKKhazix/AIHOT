// External collection reports (POST /api/ingest/items). Same identity rules and timeline
// rule as every other entrance: old or future-dated items and explicit backfill never count as
// today's news and are never pushed. Unknown sources are created isolated, awaiting an operator.
import { sql } from "../db.ts";
import * as cheerio from "cheerio";
import { upsertMaterial, updatePresentation, type MediaItem } from "../content/materials.ts";
import { queueProcessing } from "../jobs/content.ts";
import { readPublicationDate } from "../sources/dates.ts";
import { identityKeyForUrl, normalizeUrl } from "../lib/url.ts";
import { escapeXml, stripTags } from "../lib/text.ts";
import { sanitizeBody, textToHtml } from "../content/sanitize.ts";
import { mpArticle, mpProviderName } from "../providers/wechat.ts";

export const MAX_ITEMS = 50;
// Images accepted per item; matches the documented limit in docs/sources.md.
const MAX_IMAGES = 6;

export class IngestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ItemIn {
  title?: unknown;
  url?: unknown;
  publishedAt?: unknown;
  author?: unknown;
  bodyText?: unknown;
  images?: unknown;
  raw?: { _aihot?: { backfill?: boolean; baseline?: boolean } } & Record<string, unknown>;
}

function imageUrls(value: unknown): Array<{ kind: "image"; url: string }> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const images: Array<{ kind: "image"; url: string }> = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    try {
      const url = new URL(entry.trim());
      if (!["http:", "https:"].includes(url.protocol) || seen.has(url.href)) continue;
      seen.add(url.href);
      images.push({ kind: "image", url: url.href });
      if (images.length === MAX_IMAGES) break;
    } catch {
      // Ignore malformed optional image URLs.
    }
  }
  return images;
}

/** Only the manual WeChat source's article pages may trigger a paid provider lookup. */
function isManualWechatArticle(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "mp.weixin.qq.com" && !parsed.port
      && !parsed.username && !parsed.password && /^\/s(?:\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function ingestItems(body: { sourceId?: unknown; sourceName?: unknown; items?: unknown }): Promise<{ ok: true; created: number }> {
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  const items = Array.isArray(body.items) ? (body.items as ItemIn[]) : [];
  if (!sourceId || !items.length) throw new IngestError(400, "sourceId and items[] required");
  if (items.length > MAX_ITEMS) throw new IngestError(413, `items[] exceeds max ${MAX_ITEMS} per request`);

  const [source] = await sql<{ id: string; kind: string; participation_mode: string; enabled: boolean }[]>`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
    VALUES (${sourceId.slice(0, 120)}, ${typeof body.sourceName === "string" && body.sourceName.trim() ? body.sourceName.trim().slice(0, 200) : sourceId.slice(0, 120)},
            'external', '{}'::jsonb, 'T2', 'isolated', 1440, true, 'ok', ${["ingest:auto-created"]})
    ON CONFLICT (id) DO UPDATE SET last_ok_at = now() WHERE sources.enabled
    RETURNING id, kind, participation_mode, enabled`;
  if (!source) throw new IngestError(409, "source paused");

  const seen = new Set<string>();
  let created = 0;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const title = typeof it.title === "string" ? it.title.trim() : "";
    const rawUrl = typeof it.url === "string" ? it.url.trim() : "";
    if (!title || !rawUrl) continue;
    const url = normalizeUrl(rawUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const manualWechat = source!.id === "wechat-manual" && source!.kind === "external" && isManualWechatArticle(rawUrl);
    let publication = manualWechat
      ? { publishedAt: null, publicationTime: null }
      : readPublicationDate(typeof it.publishedAt === "string" ? it.publishedAt : null, "+00:00");
    const flags = it.raw?._aihot ?? {};
    let author = typeof it.author === "string" ? it.author.slice(0, 200) : null;
    let excerpt: string | null = null;
    // body_text is intentionally stored raw (no sanitization); sanitization is applied only to
    // body_html so that model analysis sees the original text without escaped entities.
    let bodyText = typeof it.bodyText === "string" && it.bodyText.trim() ? it.bodyText.trim() : null;
    let bodyStatus: "pending" | "ok" | "none" = bodyText ? "ok" : "pending";
    const media = imageUrls(it.images);
    let bodyHtml = bodyText ? textToHtml(bodyText) : null;
    let raw = it.raw ?? null;

    if (manualWechat) {
      const identity = identityKeyForUrl(rawUrl);
      // A push retry must not buy a second detail lookup or backfill articles that already existed.
      const [known] = identity
        ? await sql<{ id: string }[]>`SELECT id FROM articles WHERE identity_key = ${identity} LIMIT 1`
        : [];
      if (known) {
        // The sender's timestamp describes the share, not the article. Never apply it to an existing row.
        publication = { publishedAt: null, publicationTime: null };
      } else {
        const article = await mpArticle(rawUrl, { subject: source!.id, identity: identity ?? rawUrl });
        publication = readPublicationDate(typeof article.pubtime === "string" ? article.pubtime : null, "+08:00");
        author = typeof article.author === "string" && article.author ? article.author : author;
        excerpt = typeof article.desc === "string" ? article.desc : null;
        const content = typeof article.content === "string" ? article.content : "";
        if (content) {
          bodyHtml = sanitizeBody(content, rawUrl);
          bodyText = stripTags(content) || null;
          bodyStatus = bodyText ? "ok" : "none";
        } else {
          bodyStatus = "none";
        }
        const incomingRaw = it.raw && typeof it.raw === "object" && !Array.isArray(it.raw)
          ? it.raw as Record<string, unknown> : {};
        const provider = mpProviderName();
        const incomingProvider = incomingRaw[provider] && typeof incomingRaw[provider] === "object" && !Array.isArray(incomingRaw[provider])
          ? incomingRaw[provider] as Record<string, unknown> : {};
        raw = { ...incomingRaw, [provider]: { ...incomingProvider, receiptId: article.receiptId } };
      }
    }
    const res = await sql.begin(async (tx) => {
      const result = await upsertMaterial({
        sourceId: source!.id,
        // Normalize only for deduplication. Ownership needs the reported origin (including www and
        // scheme), and upsertMaterial already applies the common normalized identity rule.
        url: rawUrl,
        title,
        author,
        ...publication,
        excerpt,
        bodyHtml,
        bodyText,
        bodyStatus,
        media: Array.isArray(it.images) ? media : undefined,
        raw,
        via: "ingest",
        backfill: flags.backfill ? "reported-backfill" : flags.baseline ? "reported-baseline" : null,
      }, tx);
      if (bodyText || Array.isArray(it.images)) {
        const [stored] = await tx<{ source_id: string; body_html: string | null; media: MediaItem[] }[]>`
          SELECT source_id, body_html, media FROM articles WHERE id = ${result.articleId} FOR UPDATE`;
        // Only the owning source can update presentation, just as with the material itself.
        // The row cannot vanish in normal flow; a null stored means a concurrent delete between
        // upsert and this select, which is only observed under test contention. Skip the
        // presentation update and emit a warning rather than silently no-op.
        if (!stored) {
          console.warn(JSON.stringify({ level: "warn", msg: "ingest: article vanished before presentation update", articleId: result.articleId }));
        } else if (stored.source_id === source!.id) {
          // cheerio.load with the third arg false loads a fragment; $.html() returns the inner
          // HTML of the root node in this version. This alias has changed across cheerio majors;
          // if cheerio is upgraded, verify no <html><body> wrapper appears in the output.
          const $ = cheerio.load(stored.body_html ?? "", null, false);
          $("[data-ingest-images]").remove();
          const storedImages = stored.media.filter(image => image.kind === "image");
          if (storedImages.length) {
            $.root().append(`<div data-ingest-images>${storedImages.map(image => `<p><img src="${escapeXml(image.url)}"></p>`).join("")}</div>`);
          }
          await updatePresentation(tx, result.articleId, { html: $.html() });
        }
      }
      return result;
    });
    if (res.created) created += 1;
    if (res.created || res.revised || res.processingNeeded) await queueProcessing(res.articleId);
  }
  await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now() WHERE id = ${source!.id}`;
  await sql`INSERT INTO ingest_events (client, kind, status, summary) VALUES ('ingest-items', 'items', 'ok', ${sql.json({ sourceId: source!.id, received: items.length, created })})`;
  return { ok: true, created };
}
