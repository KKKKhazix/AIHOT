// Textless and link-only posts keep their own text and media instead of model-written copy.
import { collapseWhitespace } from "../lib/text.ts";

export const isEmptyOrLinkOnly = (text: string) => !text.replace(/https?:\/\/\S+/giu, "").trim();

/** The post and its already fetched long article are one text for writing and public reading. */
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
