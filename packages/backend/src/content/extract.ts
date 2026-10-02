// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import * as cheerio from "cheerio";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { dropPageChrome } from "./sanitize.ts";
import { bodyToMarkdown, markdownToBody } from "./markdown.ts";
import { contentHash, type MediaItem, type XPostData } from "./materials.ts";
import { bodyReadingMode } from "./reading-config.ts";
import type { BodyRules } from "./blocks.ts";
export type { BodyRules } from "./blocks.ts";
import { markdownBody } from "./markdown.ts";

export interface ExtractedBody {
  html: string;
  markdown: string;
  text: string;
  snapshotHtml: string;
  selector?: string;
  confirmed: boolean;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "selector" | "jina";
}

const MIN_BODY_CHARS = 200;

function extracted(html: string, url: string, via: ExtractedBody["via"], explicit = false): ExtractedBody | null {
  const markdown = bodyToMarkdown(html, url);
  const clean = markdownToBody(markdown, url);
  const text = stripTags(clean);
  const $ = cheerio.load(clean, null, false);
  const images: ExtractedBody["images"] = [];
  $("img[src]").each((_, el) => {
    const img = $(el);
    const src = img.attr("src")!;
    if (images.length >= 12 || !/^https?:\/\//.test(src) || images.some((image) => image.url === src)) return;
    images.push({ kind: "image", url: src, width: Number(img.attr("width")) || null, height: Number(img.attr("height")) || null });
  });
  const confirmed = explicit ? !!text.trim() || images.length > 0 : text.length >= MIN_BODY_CHARS;
  if (!confirmed && (bodyReadingMode() === "off" || !images.length)) return null;
  return { html: clean, markdown, text, images, via, snapshotHtml: html, confirmed };
}

export function readable(html: string, url: string, rules: BodyRules = {}): ExtractedBody | null {
  const $ = cheerio.load(html);
  if (rules.selector) {
    const selected = $(rules.selector);
    // Missing or ambiguous containers must never fall back to the whole page.
    if (selected.length !== 1) return null;
    const got = extracted(dropPageChrome(selected.html() ?? "", rules.removeSelectors), url, "selector", true);
    return got ? { ...got, selector: rules.selector, snapshotHtml: dropPageChrome($.html(selected), rules.removeSelectors) } : null;
  }
  $("body > header, body > footer").remove();
  const { document } = parseHTML(dropPageChrome($.html(), rules.removeSelectors));
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: true }).parse();
  const result = article?.content ? extracted(article.content, url, "readability") : null;
  if (result) return result;
  // Keep an image-only candidate for semantic confirmation; never call it confirmed full text.
  if (bodyReadingMode() !== "off") {
    const candidate = $("article, main").first();
    const html = candidate.length ? candidate.html() ?? "" : $("body").html() ?? "";
    const got = extracted(dropPageChrome(html, rules.removeSelectors), url, "readability", true);
    return got?.images.length ? { ...got, confirmed: false } : null;
  }
  return null;
}

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string; body?: BodyRules }): Promise<ExtractedBody | null> {
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url, opts.body);
      if (got) return got;
    }
  } catch {
    // fall through to Jina
  }
  if (!opts.allowJina) return null;
  try {
    // CSS rules need the rendered DOM, not Markdown with all selectors already erased.
    const hasRules = !!opts.body?.selector || !!opts.body?.removeSelectors?.length;
    const page = await jinaRead(url, { purpose: "body_fallback", subject: opts.subject, format: hasRules ? "html" : "markdown" });
    if (hasRules) {
      const got = readable(page.markdown, url, opts.body);
      return got ? { ...got, via: "jina" } : null;
    }
    return extracted(markdownBody(page.markdown, url), url, "jina");
  } catch (error) {
    if (error instanceof BudgetExceededError) return null;
    throw error;
  }
}

/** Pages extraction can fetch: ordinary web pages (X posts and WeChat articles arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string, allowJina = process.env.JINA_BODY_FALLBACK !== "false"): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; x_post: { tweetId?: string } | null; config: { body?: BodyRules } }[]>`
    SELECT a.id, a.url, a.body_status, a.revision, a.x_post, s.config FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision);
  const got = await extractFromUrl(a.url, { allowJina, subject: `article:${a.id}`, body: a.config.body });
  if (!got) {
    return markUnconfirmed(articleId, a.revision);
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null }[]>`
      SELECT title, excerpt, content_hash FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt, bodyHtml: got.html, media: got.images });
    if (hash === row.content_hash) {
      await tx`UPDATE articles SET body_status = ${got.confirmed ? 'ok' : 'unconfirmed'}, body_snapshot_html = ${got.snapshotHtml}, body_snapshot_selector = ${got.selector ?? null}, updated_at = now() WHERE id = ${articleId}`;
      return got.confirmed ? "ok" : "unconfirmed";
    }
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET body_html = ${got.html}, body_snapshot_html = ${got.snapshotHtml}, body_snapshot_selector = ${got.selector ?? null}, body_text = ${got.text}, body_status = ${got.confirmed ? "ok" : "unconfirmed"},
        media = ${tx.json(got.images as never)}::jsonb,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${got.text})`;
    return got.confirmed ? "ok" : "unconfirmed";
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
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; body_html: string | null; media: MediaItem[]; x_post: XPostData | null; x_article: { title?: string | null; text?: string } | null }[]>`
      SELECT title, excerpt, body_text, body_html, media, x_post, x_article FROM articles
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
    const hash = contentHash({ title, bodyText, excerpt: row.excerpt, bodyHtml: row.body_html, media: row.media, xPost: row.x_post });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET title = ${title}, body_text = ${bodyText}, x_article = ${tx.json(got as never)}, body_status = 'ok',
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${title}, ${bodyText})`;
    return "ok";
  });
}

export { collapseWhitespace };
