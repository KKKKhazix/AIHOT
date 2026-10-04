// SocialData (X search). Paid per request: every call goes through receipts and the budget.
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { assertAccepted, paidRequest, type CallOutcome, type ReceiptRequest, type ReceiptResult } from "./receipts.ts";

export interface SdUser {
  name: string;
  screen_name: string;
  profile_image_url_https?: string;
}

export interface SdMedia {
  type: "photo" | "video" | "animated_gif";
  media_url_https: string;
  original_info?: { width?: number; height?: number };
}

export interface SdTweet {
  id_str: string;
  tweet_created_at: string;
  full_text?: string;
  text?: string;
  lang?: string;
  user: SdUser;
  in_reply_to_status_id_str?: string | null;
  in_reply_to_screen_name?: string | null;
  quoted_status?: SdTweet | null;
  retweeted_status?: SdTweet | null;
  is_quote_status?: boolean;
  entities?: { urls?: Array<{ url: string; expanded_url: string }>; media?: SdMedia[] };
  extended_entities?: { media?: SdMedia[] };
  favorite_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  views_count?: number;
}

export interface SearchResult {
  tweets: SdTweet[];
  nextCursor: string | null;
  receiptId: number;
  reused: boolean;
}

/**
 * SocialData bills US$0.20 per 1,000 objects returned by a successful response. Recorded per call as an
 * estimate.
 */
function objectsCost(objects: number) {
  return { amount: objects * 0.0002, currency: "USD", basis: "estimated" as const };
}

/** The API root; tests point it at a local stub. */
function apiBase(): string {
  return (credential("collectors", "SOCIALDATA_BASE_URL") ?? "https://api.socialdata.tools").replace(/\/$/, "");
}

/**
 * One paid GET behind a receipt; `settle` turns the parsed answer into what the receipt keeps. A lookup
 * passes the usage of its 404 as `missing`: the post or article does not exist, an answer that costs
 * nothing. Any other status outside 2xx means SocialData did not take the request (assertAccepted).
 */
async function get<T>(path: string, request: Omit<ReceiptRequest, "service">,
  read: { timeoutMs: number; maxBytes: number; missing?: Record<string, unknown>; settle: (json: T) => CallOutcome }): Promise<ReceiptResult> {
  const key = credential("collectors", "SOCIALDATA_API_KEY");
  if (!key) throw new Error("SOCIALDATA_API_KEY is not configured");
  return paidRequest({ service: "socialdata", ...request }, async () => {
    const res = await guardedFetch(`${apiBase()}${path}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      timeoutMs: read.timeoutMs,
      maxBytes: read.maxBytes,
      route: "direct",
    });
    if (res.status === 404 && read.missing) return { response: null, usage: read.missing, cost: null };
    const text = res.text();
    assertAccepted("socialdata", res.status, text);
    return read.settle(JSON.parse(text) as T);
  });
}

/** Lookups of one post or article. */
const LOOKUP = { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 };

/**
 * Searches recent tweets. `window` makes the receipt identity time-bucketed so a retry in the same
 * bucket reuses the stored response instead of paying again.
 */
export async function searchTweets(query: string, opts: { purpose: string; subject: string; window: string; type?: "Latest" | "Top"; cursor?: string | null }): Promise<SearchResult> {
  const type = opts.type ?? "Latest";
  const sp = new URLSearchParams({ query, type });
  if (opts.cursor) sp.set("cursor", opts.cursor);
  const receipt = await get<{ tweets?: SdTweet[] }>(`/twitter/search?${sp}`,
    { purpose: opts.purpose, subject: opts.subject, identity: { query, type, cursor: opts.cursor ?? null, window: opts.window }, requestSummary: { query, type } },
    {
      // Deeper pages of a search over two dozen accounts can take well over 20 seconds.
      timeoutMs: 60_000,
      maxBytes: 12 * 1024 * 1024,
      settle: (json) => {
        const tweets = json.tweets?.length ?? 0;
        return { response: json, usage: { tweets }, cost: objectsCost(tweets) };
      },
    });
  const json = receipt.response as { tweets?: SdTweet[]; next_cursor?: string | null };
  return { tweets: json.tweets ?? [], nextCursor: json.next_cursor ?? null, receiptId: receipt.receiptId, reused: receipt.reused };
}

export function tweetText(t: SdTweet): string {
  // These escapes belong to the provider's plain-text payload, not markup. Decode once, before
  // inserting expanded URLs: literal code and the destination URLs must keep their own bytes.
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };
  let text = (t.full_text ?? t.text ?? "").replace(/&(?:amp|lt|gt);/g, entity => entities[entity]!);
  // Expand t.co links and drop trailing media links.
  for (const u of t.entities?.urls ?? []) text = text.replaceAll(u.url, u.expanded_url);
  for (const m of t.extended_entities?.media ?? t.entities?.media ?? []) text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, "");
  return text.trim();
}

export function tweetMedia(t: SdTweet) {
  return (t.extended_entities?.media ?? t.entities?.media ?? []).map((m) => ({
    kind: m.type === "photo" ? ("image" as const) : ("video" as const),
    url: m.media_url_https,
    width: m.original_info?.width ?? null,
    height: m.original_info?.height ?? null,
    poster: m.type === "photo" ? null : m.media_url_https,
  }));
}

/** An X Article: its title and body as DraftJS blocks (header-two, blockquote, list items, atomic media…). */
export interface SdArticle {
  title?: string;
  content_state?: { blocks?: Array<{ type?: string; text?: string }> };
}

/**
 * The long-form article a post published, looked up by the id of that post (the number in an
 * `x.com/i/article/<id>` link is not it). Null when the post published none. Paid per article.
 */
export async function getArticle(tweetId: string, opts: { purpose: string; subject: string }): Promise<SdArticle | null> {
  const receipt = await get<{ article?: SdArticle; status?: string }>(`/twitter/article/${encodeURIComponent(tweetId)}`,
    { purpose: opts.purpose, subject: opts.subject, identity: { article: tweetId }, requestSummary: { article: tweetId } },
    {
      ...LOOKUP,
      missing: { articles: 0 },
      settle: (json) => {
        // A post without an article answers with the post alone, or with {status: "error"}.
        const article = json.status === "error" ? null : (json.article ?? null);
        return { response: article, usage: { articles: article ? 1 : 0 }, cost: objectsCost(1) };
      },
    });
  return (receipt.response as SdArticle | null) ?? null;
}

/** One tweet by id (context for replies and quotes). Paid; the receipt makes retries free. */
export async function getTweet(id: string, opts: { purpose: string; subject: string }): Promise<SdTweet | null> {
  const receipt = await get<SdTweet>(`/twitter/tweets/${encodeURIComponent(id)}`,
    { purpose: opts.purpose, subject: opts.subject, identity: { tweet: id }, requestSummary: { tweet: id } },
    { ...LOOKUP, missing: { tweets: 0 }, settle: (json) => ({ response: json, usage: { tweets: 1 }, cost: objectsCost(1) }) });
  return (receipt.response as SdTweet | null) ?? null;
}
