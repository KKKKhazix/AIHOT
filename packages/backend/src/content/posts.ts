// Textless and link-only posts keep their own text and media instead of model-written copy.
import { sql } from "../db.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { tweetIdFromUrl } from "../lib/url.ts";
import { textToHtml } from "./sanitize.ts";

/** SQL expression extracting the quoted tweet ID from an x_post jsonb column (stored id or status URL). */
export const quotedTweetIdSql = (col: ReturnType<typeof sql> = sql`a.x_post`) =>
  sql`coalesce(${col}->'quoted'->>'tweetId', substring(${col}->'quoted'->>'url' from '/status(?:es)?/([0-9]+)'))`;

/** JS counterpart of quotedTweetIdSql: prefers stored tweetId, else parses the quoted status URL. */
export function quotedTweetId(xPost: { quoted?: { tweetId?: string | null; url?: string | null } | null } | null | undefined): string | null {
  if (xPost?.quoted?.tweetId) return xPost.quoted.tweetId;
  const url = xPost?.quoted?.url;
  return url ? tweetIdFromUrl(url) ?? (/\/status(?:es)?\/(\d+)/.exec(url)?.[1] ?? null) : null;
}

export const isEmptyOrLinkOnly = (text: string) => !text.replace(/https?:\/\/\S+/giu, "").trim();

/** A link to an X Article, the long-form text a post publishes. */
export const X_ARTICLE_LINK = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+/gi;

/** What a post says besides the link to the long article it publishes (the page shows that article itself). */
const postWords = (text: string) => text.replace(X_ARTICLE_LINK, "").trim();

/**
 * The body of a post with a saved long article, as every exit reads it (page, Markdown, full RSS) and as it
 * is translated: what the post says besides its link, then the article as its author laid it out.
 */
export function xArticleBody(postText: string, articleHtml: string): string {
  const words = postWords(postText);
  return (words ? textToHtml(words) : "") + articleHtml;
}

/** The post and its already fetched long article are one text for writing (and for readers where no page HTML was kept). */
export function withXArticle(xPost: Record<string, any> | null, article: { title?: string; text?: string } | null): Record<string, any> | null {
  if (!xPost || !article?.text) return xPost;
  const parts = [String(xPost.text ?? "").trim(), article.title ? `【X 长文】${article.title}` : "【X 长文】", article.text];
  return { ...xPost, text: parts.filter(Boolean).join("\n\n") };
}

/** A fetched long article supplies real material; otherwise there is nothing here to translate. */
export function originalPostCopy(post: { text?: unknown } | null | undefined, url: string, article?: { text?: string } | null): { title: string; summary: string | null } | null {
  if (!post || article?.text?.trim()) return null;
  const text = String(post.text ?? "");
  if (!isEmptyOrLinkOnly(text)) return null;
  return { title: collapseWhitespace(text) || url, summary: text.trim() ? text : null };
}
