// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { stripTags } from "../lib/text.ts";
import { isVideoPageUrl } from "../lib/video-url.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { articleUtcOffset, parseLooseDate } from "../sources/dates.ts";
import type { SourceRow } from "../sources/types.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, fillPublicationTime, reviseMaterial } from "./materials.ts";
import { markdownBody } from "./markdown.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "selector" | "jina";
  /** The page's publication metadata; neither modification time nor dates mentioned in its prose. */
  publishedAt?: Date | null;
}

const MIN_BODY_CHARS = 200;

export interface BodyExtraction {
  selector: string;
  excludeSelectors?: string[];
}

/** A publication time the page prints without a zone is read in utcOffset (the source's articleUtcOffset). */
export function readable(html: string, url: string, utcOffset?: string, bodyExtraction?: unknown): ExtractedBody | null {
  if (bodyExtraction === undefined) return readabilityBody(html, url, utcOffset);
  if (isVideoPageUrl(url)) return null;
  let baseline: ExtractedBody | null = null;
  try { baseline = readabilityBody(html, url, utcOffset); } catch {
    // The selector may still find the body when Readability cannot parse the page.
  }
  try {
    if (!bodyExtraction || typeof bodyExtraction !== "object" || Array.isArray(bodyExtraction)) return baseline;
    const { selector, excludeSelectors } = bodyExtraction as Partial<BodyExtraction>;
    if (typeof selector !== "string" || !selector.trim()) return baseline;
    if (excludeSelectors !== undefined && (!Array.isArray(excludeSelectors) || !excludeSelectors.every(s => typeof s === "string" && s.trim()))) return baseline;
    // Readability mutates its document; select from an independent copy of the original response.
    const { document } = parseHTML(html);
    const nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) return baseline;
    const body = nodes[0]!;
    for (const exclude of excludeSelectors ?? []) {
      for (const node of body.querySelectorAll(exclude)) node.remove();
    }
    if (!prepareSelectedBody(body)) return baseline;
    return cleanBody(body.outerHTML, url, "selector", baseline?.publishedAt) ?? baseline;
  } catch {
    // Invalid CSS or a failed enhancement must not discard the original extraction.
    return baseline;
  }
}

type PageElement = NonNullable<ReturnType<ReturnType<typeof parseHTML>["document"]["querySelector"]>>;

function visible(node: PageElement): boolean {
  // linkedom preserves declaration casing and !important; read just the two visibility properties.
  const style = new Map<string, { value: string; important: boolean }>();
  for (const match of (node.getAttribute("style") ?? "").matchAll(/(?:^|;)\s*(display|visibility)\s*:\s*([^;]+)(?=;|$)/gi)) {
    const property = match[1]!.toLowerCase();
    const important = /!\s*important\s*$/i.test(match[2]!);
    const value = match[2]!.replace(/!\s*important\s*$/i, "").trim().toLowerCase();
    if (!style.get(property)?.important || important) style.set(property, { value, important });
  }
  return style.get("display")?.value !== "none" && style.get("visibility")?.value !== "hidden" && !node.hasAttribute("hidden") &&
    (node.getAttribute("aria-hidden") !== "true" || (node.getAttribute("class") ?? "").includes("fallback-image"));
}

function singleImage(node: PageElement | null): PageElement | null {
  while (node && node.tagName !== "IMG") {
    if (node.children.length !== 1 || node.textContent?.trim()) return null;
    node = node.firstElementChild;
  }
  return node;
}

/** Prepare visibility and images without re-scoring the selected fragment. */
function prepareSelectedBody(body: PageElement): boolean {
  for (let node: PageElement | null = body; node; node = node.parentElement) if (!visible(node)) return false;

  // Restore noscript images before removing the hidden placeholders they replace, as Readability does.
  for (const noscript of body.querySelectorAll("noscript")) {
    const previous = noscript.previousElementSibling;
    if (!singleImage(noscript) || !singleImage(previous)) continue;
    previous!.replaceWith(noscript.firstElementChild!.cloneNode(true));
    noscript.remove();
  }
  for (const node of body.querySelectorAll("*")) if (!visible(node)) node.remove();

  for (const node of [body, ...body.querySelectorAll("img, figure")]) {
    if (node.tagName !== "IMG" && node.tagName !== "FIGURE") continue;
    if (node.tagName === "FIGURE" && node.querySelector("img, picture")) continue;
    const src = node.getAttribute("src") ?? "";
    const srcset = node.getAttribute("srcset");
    const base64 = /^data:\s*([^\s;,]+)\s*;\s*base64\s*,/i.exec(src);
    if (base64?.[1]?.toLowerCase() === "image/svg+xml") continue;
    // The same small base64 placeholder check Readability uses for lazy images.
    const placeholder = base64 && src.length - base64[0].length < 133;
    if (placeholder && [...node.attributes].some(attr => attr.name !== "src" && /\.(jpg|jpeg|png|webp)/i.test(attr.value))) node.removeAttribute("src");
    if ((src || (srcset && srcset !== "null")) && !placeholder && !(node.getAttribute("class") ?? "").toLowerCase().includes("lazy")) continue;
    let image = node.tagName === "IMG" ? node : null;
    for (const attr of [...node.attributes]) {
      if (["src", "srcset", "alt"].includes(attr.name) || !/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/i.test(attr.value)) continue;
      if (!image) {
        image = body.ownerDocument!.createElement("img");
        node.appendChild(image);
      }
      image.setAttribute("src", attr.value);
    }
  }
  return true;
}

function readabilityBody(html: string, url: string, utcOffset?: string): ExtractedBody | null {
  if (isVideoPageUrl(url)) return null;
  const { document } = parseHTML(html);
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const body = cleanBody(article.content, url, "readability");
  if (body) body.publishedAt = parseLooseDate(article.publishedTime, utcOffset);
  return body;
}

function cleanBody(html: string, url: string, via: ExtractedBody["via"], publishedAt?: Date | null): ExtractedBody | null {
  const clean = trimTrailingChrome(sanitizeBody(html, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via, publishedAt };
}

export async function extractFromUrl(url: string, subject: string, utcOffset?: string, bodyExtraction?: unknown): Promise<ExtractedBody | null> {
  if (isVideoPageUrl(url)) return null;
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    if (isVideoPageUrl(res.url)) return null;
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url, utcOffset, bodyExtraction);
      if (got) return got;
    }
  } catch {
    // fall through to Jina
  }
  try {
    const page = await jinaRead(url, { purpose: "body_fallback", subject });
    const html = markdownBody(page.markdown, url);
    const text = stripTags(html);
    if (text.length < MIN_BODY_CHARS) return null;
    return { html, text, images: [], via: "jina" };
  } catch (error) {
    if (error instanceof BudgetExceededError) return null;
    throw error;
  }
}

/** Ordinary article pages; player pages have no article body, and social posts arrive separately. */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account" || isVideoPageUrl(url)) return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; x_post: { tweetId?: string } | null; config: SourceRow["config"] }[]>`
    SELECT a.id, a.url, a.body_status, a.revision, a.x_post, s.config
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision);
  const got = await extractFromUrl(a.url, `article:${a.id}`, articleUtcOffset(a.config), a.config.bodyExtraction);
  if (!got) {
    return markUnconfirmed(articleId, a.revision);
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null }[]>`
      SELECT title, excerpt, content_hash FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const time = a.config.detail?.publishedAtAuthoritative === true ? null : await fillPublicationTime(tx, articleId, got.publishedAt);
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    if (!time && hash === row.content_hash) {
      await tx`UPDATE articles SET body_status = 'ok', updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${sql.json(got.images as never)}::jsonb ELSE media END`,
      hash, title: row.title, bodyText: got.text,
    });
    return "ok";
  });
}

async function markUnconfirmed(articleId: string, revision: number): Promise<"unconfirmed" | "skipped"> {
  const rows = await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now()
    WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' RETURNING id`;
  return rows.length ? "unconfirmed" : "skipped";
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; a post that is only the article's link takes the article's title.
 * No article (the link points at someone else's, or X has none) leaves the post "unconfirmed", and
 * the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string, revision: number): Promise<"ok" | "unconfirmed" | "skipped"> {
  const found = await getArticle(tweetId, { purpose: "x_article", subject: `article:${articleId}` });
  const got = found ? xArticleText(found) : null;
  if (!got) {
    return markUnconfirmed(articleId, revision);
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null; x_article: { title?: string | null; text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post, x_article FROM articles
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const block = (a: { title?: string | null; text?: string } | null) => (a ? [a.title ? `# ${a.title}` : "", a.text ?? ""].filter(Boolean).join("\n\n") : "");
    // The post's own text, without an article appended by an earlier extraction (an admin re-run
    // extracts again from the post; appending once more would repeat the article).
    const previous = block(row.x_article);
    let base = row.body_text ?? "";
    if (previous && base.endsWith(previous)) base = base.slice(0, -previous.length).replace(/\s+$/, "");
    const title = got.title && onlyXArticleLink(row.x_post?.text) ? got.title : row.title;
    const bodyText = [base, block(got)].filter(Boolean).join("\n\n");
    if (bodyText === row.body_text && title === row.title) {
      // The same article again: nothing new, no new revision.
      await tx`UPDATE articles SET body_status = 'ok', x_article = ${tx.json(got as never)}, updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`title = ${title}, body_text = ${bodyText}, x_article = ${sql.json(got as never)}, body_status = 'ok'`,
      hash: contentHash({ title, bodyText, excerpt: row.excerpt }), title, bodyText,
    });
    return "ok";
  });
}
