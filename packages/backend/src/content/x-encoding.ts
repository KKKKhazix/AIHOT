// A reviewable, one-time representation repair for confirmed escaped X material. It reconstructs
// only the stored post and quote; appended long-form content and editorial decisions are not inputs.
import { sha256, stableJson } from "../lib/ids.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { decodeTweetEntities } from "../providers/socialdata.ts";
import { contentHash, type XPostData } from "./materials.ts";

export interface XEncodingMaterial {
  id: string;
  kind: string;
  identity_key: string;
  url: string;
  revision: number;
  content_hash: string | null;
  title: string;
  body_text: string | null;
  excerpt: string | null;
  x_post: XPostData | null;
  x_article: { title?: string | null; text?: string } | null;
}

/** Covers every material field the plan reads, including metadata not covered by content_hash. */
export function xEncodingMaterialHash(a: XEncodingMaterial): string {
  return sha256(stableJson({ id: a.id, kind: a.kind, identity: a.identity_key, url: a.url, revision: a.revision,
    contentHash: a.content_hash, title: a.title, body: a.body_text, excerpt: a.excerpt, post: a.x_post, article: a.x_article }));
}

// Stored post text already has expanded URLs. Their bytes were not encoded as post prose.
const decodeStoredPost = (text: string) => text.replace(/https?:\/\/\S+|&(?:amp|lt|gt);/g,
  part => /^https?:\/\//.test(part) ? part : decodeTweetEntities(part));
const postBody = (post: XPostData) => [post.text, post.quoted ? `\n\n【引用 @${post.quoted.handle}】${post.quoted.text}` : ""].join("").trim();

/** Pure plan for operator review; unexpected shapes are refused instead of guessed. */
export function xEncodingRepairPlan(a: XEncodingMaterial) {
  if (a.kind !== "x_search" || !a.x_post || typeof a.x_post.text !== "string") throw new Error("Only confirmed X provider text can be normalized");
  if (a.identity_key !== `x:${a.x_post.tweetId}` || identityKeyForUrl(a.url) !== a.identity_key) throw new Error("X material identity does not match its post");
  const oldPost = a.x_post;
  if (oldPost.quoted && (typeof oldPost.quoted.text !== "string" || typeof oldPost.quoted.handle !== "string")) throw new Error("X quote text has an unsupported shape");
  const nextPost: XPostData = { ...oldPost, text: decodeStoredPost(oldPost.text),
    ...(oldPost.quoted ? { quoted: { ...oldPost.quoted, text: decodeStoredPost(oldPost.quoted.text) } } : {}) };
  const oldBase = postBody(oldPost);
  const nextBase = postBody(nextPost);
  const tail = a.x_article ? [a.x_article.title ? `# ${a.x_article.title}` : "", a.x_article.text ?? ""].filter(Boolean).join("\n\n") : "";
  const fullBody = tail ? [oldBase, tail].filter(Boolean).join("\n\n") : oldBase;
  if ((a.body_text ?? "") !== fullBody) throw new Error("Stored body is not the confirmed X post/quote/article composition");
  const bodyText = tail ? [nextBase, tail].filter(Boolean).join("\n\n") : nextBase;
  const firstLine = collapseWhitespace(oldPost.text.split("\n").find(line => line.trim()) ?? oldPost.text);
  const truncated = a.title.replace(/(?:\.\.\.|…)$/, "");
  const sourceTitle = a.title === firstLine || (truncated !== a.title && firstLine.startsWith(truncated));
  const title = sourceTitle ? decodeStoredPost(a.title) : a.title;
  const changed = title !== a.title || bodyText !== (a.body_text ?? "") || stableJson(nextPost) !== stableJson(oldPost);
  const before = { title: a.title, body_text: a.body_text, x_post: oldPost, content_hash: a.content_hash };
  const after = { title, body_text: a.body_text === null && !bodyText ? null : bodyText, x_post: nextPost,
    content_hash: changed ? contentHash({ title, bodyText, excerpt: a.excerpt }) : a.content_hash };
  return { articleId: a.id, version: a.revision, hash: xEncodingMaterialHash(a), changed,
    preservedTitle: !sourceTitle, before, after };
}
