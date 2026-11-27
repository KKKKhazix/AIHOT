// Article body extraction: network fetch, Jina fallback and database revision persistence.
// Pure HTML/DOM/Readability parsing lives in content/readable.ts.
import { DEPLOYMENT } from "@aihot/site";
import { sql } from "../db.ts";
import { guardedFetch, languageHeaders } from "../lib/http-fetch.ts";
import { assertPageContent, UnavailablePageError } from "../lib/page-content.ts";
import { escapeXml, stripTags } from "../lib/text.ts";
import { isVideoPageUrl } from "../lib/video-url.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import type { SourceRow } from "../sources/types.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { contentHash, fillPublicationTime, reviseMaterial, updatePresentation, type MediaItem } from "./materials.ts";
import { markdownBody } from "./markdown.ts";
import { articleCover } from "./cover.ts";
import {
  isSignInRedirect, isSignInUrl, MIN_BODY_CHARS, pagePublicationDate, pageRules, readable, readableDocument,
  type ExtractedBody, type PageRules, type PreserveRule,
} from "./readable.ts";

export {
  isSignInRedirect, isSignInUrl, pagePublicationDate, pageRules, readable, readableDocument,
  type ExtractedBody, type PageRules, type PreserveRule,
};

/**
 * What the browser renderer leaves out of a body it reads: its answer is the whole page, so a site that
 * refuses the direct fetch had its consent dialog, navigation and footer stored and translated as the
 * article. Only what a page itself marks as not being the article: narrowing to main or running
 * Readability over the rendered page lost real text on many sites.
 */
const PAGE_CHROME = "nav,footer,dialog,header:not(article header,main header),[role=banner],[role=navigation],[role=contentinfo],[role=dialog],[role=alertdialog],[aria-modal=true],#onetrust-consent-sdk";


export async function extractFromUrl(url: string, subject: string, rules: PageRules = {}, opts: { paidFallback?: boolean; sourceId?: string } = {}): Promise<ExtractedBody | null> {
  if (isVideoPageUrl(url)) return null;
  const target = new URL(url);
  if (rules.bodyUrlSuffix) target.pathname += rules.bodyUrlSuffix;
  let read: { body: ExtractedBody; pageUrl: string } | null = null;
  try {
    const res = await guardedFetch(target.href, { headers: languageHeaders(rules.acceptLanguage), timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024 });
    if (isVideoPageUrl(res.url)) return null;
    if (isSignInRedirect(url, res.url)) return null;
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /^(?:text\/plain|text\/markdown|text\/x-(?:diff|patch))\b/i.test(type)) {
      const text = res.text().trim();
      if (text.length < MIN_BODY_CHARS) return null;
      assertPageContent("", text);
      return { html: `<pre>${escapeXml(text)}</pre>`, text, images: [], via: "text" };
    }
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url, rules);
      if (got) read = { body: got, pageUrl: res.url };
    }
  } catch {
    // fall through to Jina
  }
  // Outside the page's read: a failure of the store while checking the cover is no unreadable page.
  if (read) return { ...read.body, cover: await articleCover(read.body.cover ?? null, url, read.pageUrl, opts.sourceId) };
  if (opts.paidFallback === false) return null;
  try {
    // The rendered text carries none of the page's metadata, so a body read this way has no cover.
    const extra = (DEPLOYMENT as { renderedArticleRemoveSelectors?: Record<string, string> }).renderedArticleRemoveSelectors?.[target.hostname];
    const page = await jinaRead(target.href, { purpose: "body_fallback", subject, removeSelector: extra ? `${PAGE_CHROME},${extra}` : PAGE_CHROME });
    const html = markdownBody(page.markdown, url);
    const text = stripTags(html);
    if (text.length < MIN_BODY_CHARS) return null;
    return { html, text, images: [], via: "jina" };
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof UnavailablePageError) return null;
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
  const [a] = await sql<{ id: string; source_id: string; url: string; body_status: string; revision: number; x_post: { tweetId?: string } | null; config: SourceRow["config"] }[]>`
    SELECT a.id, a.source_id, a.url, a.body_status, a.revision, a.x_post, s.config
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision);
  const got = await extractFromUrl(a.url, `article:${a.id}`, pageRules(a.config), { sourceId: a.source_id });
  if (!got) {
    return markUnconfirmed(articleId, a.revision);
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null; media: MediaItem[] }[]>`
      SELECT title, excerpt, content_hash, media FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const time = a.config.detail?.publishedAtAuthoritative === true ? null : await fillPublicationTime(tx, articleId, got.publishedAt, undefined, got.publicationTime);
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    // A cover decided before (when the article was first stored) stays.
    const cover = got.cover ? sql.json(got.cover as never) : null;
    if (!time && hash === row.content_hash) {
      await updatePresentation(tx, articleId, { html: got.html, media: row.media.length ? row.media : got.images, cover: got.cover ?? undefined });
      await tx`UPDATE articles SET body_status = 'ok', cover = coalesce(cover, ${cover}::jsonb), updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok', cover = coalesce(cover, ${cover}::jsonb),
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
  const got = found ? xArticleText(found, `https://x.com/i/status/${tweetId}`) : null;
  if (!got) {
    return markUnconfirmed(articleId, revision);
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null; x_article: { title?: string | null; text?: string; html?: string | null } | null }[]>`
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
      // The same words can have new media or HTML blocks. Update their presentation (or revise when policy requires review).
      if (got.html) {
        await updatePresentation(tx, articleId, { xArticleHtml: got.html });
      }
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
