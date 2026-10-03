// Discovery and static files: sitemap, llms.txt, the site's public files (robots.txt, security.txt, the web
// manifest, the OpenAPI document), icons, the IndexNow key and the about page's contact codes.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SITE } from "@aihot/industry/site";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { PUBLIC_API_CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { REPO_ROOT, config } from "@aihot/backend/config";
import { applyPublicHeaders, sendTextWithEtag } from "../http/respond.ts";
import { sitemapXml } from "@aihot/backend/publication/sitemap";
import { llmsTxt, loadLlmsAvailability } from "@aihot/backend/publication/llms";

const PUBLIC = path.join(REPO_ROOT, "industry/public");
const BRAND = path.join(REPO_ROOT, "industry/brand");

const TYPES: Record<string, string> = {
  ".json": "application/json; charset=UTF-8",
  ".txt": "text/plain; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/**
 * A public file's `{{…}}` placeholders: the site's name, address, description, tagline and locale, the
 * public interface version and the category list (JSON-escaped in JSON files). In a JSON document, an
 * `enum` or `examples` list holding "{{categories}}" becomes the list of category keys.
 */
function fillPlaceholders(text: string, json: boolean): string {
  const values: Record<string, string> = {
    siteName: SITE.name,
    siteUrl: config.siteUrl,
    description: SITE.description,
    tagline: SITE.tagline,
    locale: SITE.locale,
    version: PUBLIC_INTERFACE_VERSION,
    categoryList: PUBLIC_API_CATEGORY_KEYS.join(", "),
  };
  const filled = text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => {
    const value = values[key];
    if (value === undefined) return all;
    return json ? JSON.stringify(value).slice(1, -1) : value;
  });
  if (!json || !filled.includes('"{{categories}}"')) return filled;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const key of ["enum", "examples"]) if (Array.isArray(o[key]) && (o[key] as unknown[]).includes("{{categories}}")) o[key] = [...PUBLIC_API_CATEGORY_KEYS];
    for (const v of Object.values(o)) walk(v);
  };
  const doc: unknown = JSON.parse(filled);
  walk(doc);
  return JSON.stringify(doc, null, 2);
}

interface Entry {
  body: Buffer;
  etag: string;
}

const etagOf = (body: Buffer) => `W/"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;

const fileCache = new Map<string, Entry & { mtime: number }>();

/** A file's bytes and ETag, read again when it changes; `fill` fills in a public file's placeholders. */
async function loadFile(file: string, fill = false): Promise<Entry> {
  const s = await stat(file);
  const cached = fileCache.get(file);
  if (cached && cached.mtime === s.mtimeMs) return cached;
  let body = await readFile(file);
  if (fill && body.includes("{{")) body = Buffer.from(fillPlaceholders(body.toString("utf8"), /\.(json|webmanifest)$/.test(file)));
  const entry = { body, etag: etagOf(body), mtime: s.mtimeMs };
  fileCache.set(file, entry);
  return entry;
}

function sendEntry(req: FastifyRequest, reply: FastifyReply, entry: Entry, opts: { type: string; cacheControl: string; publicApi?: boolean }) {
  if (opts.publicApi) applyPublicHeaders(reply);
  reply.header("Content-Type", opts.type);
  reply.header("Cache-Control", opts.cacheControl);
  reply.header("ETag", entry.etag);
  if (req.headers["if-none-match"] === entry.etag) return reply.code(304).send();
  return reply.send(entry.body);
}

async function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, opts: { type?: string; cacheControl: string; publicApi?: boolean; fill?: boolean }) {
  let entry;
  try {
    entry = await loadFile(file, opts.fill);
  } catch {
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  }
  return sendEntry(req, reply, entry, { type: opts.type ?? TYPES[path.extname(file)] ?? "application/octet-stream", cacheControl: opts.cacheControl, publicApi: opts.publicApi });
}

export function registerStatic(app: FastifyInstance) {
  app.get("/sitemap.xml", async (req, reply) => {
    try {
      const xml = await sitemapXml();
      return sendTextWithEtag(req, reply, xml, { etagPrefix: "sitemap", cacheControl: "public, max-age=0, s-maxage=300, must-revalidate", contentType: "application/xml" });
    } catch (error) {
      req.log.error({ err: error }, "sitemap unavailable");
      return reply.code(503).header("Retry-After", "300").header("Cache-Control", "no-store").send("Sitemap temporarily unavailable");
    }
  });

  app.get("/llms.txt", async (req, reply) => {
    const text = llmsTxt({
      ...await loadLlmsAvailability(),
    });
    applyPublicHeaders(reply, { cors: false });
    // Cached like /openapi-v1.json: a release that adds an ability is described everywhere within minutes.
    return sendTextWithEtag(req, reply, text, { etagPrefix: "llms", cacheControl: "public, max-age=300, stale-while-revalidate=3600", contentType: "text/plain; charset=utf-8" });
  });

  // The site's public files (industry/public/), placeholders filled in; one the site does not have is a 404.
  app.get("/robots.txt", (req, reply) => sendFile(req, reply, path.join(PUBLIC, "robots.txt"), { cacheControl: "public, max-age=3600", fill: true }));
  app.get("/.well-known/security.txt", (req, reply) => sendFile(req, reply, path.join(PUBLIC, ".well-known/security.txt"), { cacheControl: "public, max-age=86400", fill: true }));
  app.get("/manifest.webmanifest", (req, reply) => sendFile(req, reply, path.join(PUBLIC, "manifest.webmanifest"), { cacheControl: "public, max-age=86400, stale-while-revalidate=604800", fill: true }));
  app.get("/openapi-v1.json", (req, reply) => sendFile(req, reply, path.join(PUBLIC, "openapi-v1.json"), { cacheControl: "public, max-age=300, stale-while-revalidate=3600", publicApi: true, fill: true }));

  // IndexNow proves the key by a file at the site root named after it (INDEXNOW_KEY).
  if (config.indexNowKey) {
    const key: Entry = { body: Buffer.from(config.indexNowKey), etag: etagOf(Buffer.from(config.indexNowKey)) };
    app.get(`/${config.indexNowKey}.txt`, (req, reply) => sendEntry(req, reply, key, { type: TYPES[".txt"]!, cacheControl: "public, max-age=3600" }));
  }

  // Icons from the industry pack (industry/brand/).
  for (const icon of [
    "favicon.ico",
    "icon.png",
    "icon-192.png",
    "apple-icon.png",
    "logo.svg",
  ]) {
    app.get(`/${icon}`, (req, reply) => sendFile(req, reply, path.join(BRAND, icon), { cacheControl: "public, max-age=2592000, stale-while-revalidate=604800" }));
  }

  // Contact codes on the about page: uploaded in the admin (content-hashed names), or shipped in the pack.
  app.get("/contact/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[\w.-]+\.(png|jpg|jpeg|webp)$/.test(file)) return reply.code(404).send();
    const hashed = /-[0-9a-f]{8}\./.test(file);
    const cacheControl = hashed ? "public, max-age=31536000, immutable" : "public, max-age=3600";
    const uploaded = path.join(config.dataDir, "uploads", file);
    const target = (await stat(uploaded).then(() => true, () => false)) ? uploaded : path.join(BRAND, "contact", file);
    return sendFile(req, reply, target, { cacheControl });
  });
}
