// Textless and link-only posts keep their own text and media instead of model-written copy.
import { collapseWhitespace } from "../lib/text.ts";

export const isEmptyOrLinkOnly = (text: string) => !text.replace(/https?:\/\/\S+/giu, "").trim();

/** A fetched long article supplies real material; otherwise there is nothing here to translate. */
export function originalPostCopy(post: { text?: unknown } | null | undefined, url: string, article?: { text?: string } | null): { title: string; summary: string | null } | null {
  if (!post || article?.text?.trim()) return null;
  const text = String(post.text ?? "");
  if (!isEmptyOrLinkOnly(text)) return null;
  return { title: collapseWhitespace(text) || url, summary: text.trim() ? text : null };
}
