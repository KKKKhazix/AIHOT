// X accounts renamed under us. A search by the old handle finds nothing and still succeeds, so a
// renamed account only looks quiet. Every account quiet for a day is looked up by a stored post, whose
// author is the same account under its current handle (the newest post that still exists, of the last
// three: authors delete posts); a new handle replaces the old one in the source, and the account is read
// again from its newest stored post, so nothing posted since is missed.
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { requestRepublish } from "../jobs/publication.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { ReceiptUnknownError } from "../providers/receipts.ts";
import { getTweet, privateAccountRefusal } from "../providers/socialdata.ts";
import { collectSource } from "./collect.ts";
import { X_HANDLE, xHandle } from "./account.ts";

const DAY_MS = 86400_000;

export interface XRename {
  sourceId: string;
  from: string;
  to: string;
  /** Posts found when the account was read again under its new handle. */
  found: number;
}

/** `pauseMs` between lookups leaves room in the provider's per-minute budget for the searches. */
export async function followXRenames(opts: { now?: number; pauseMs?: number } = {}): Promise<{
  checked: number;
  renamed: XRename[];
  privateAccounts: string[];
  unknownLookups: { sourceId: string; receiptId: number }[];
}> {
  const now = opts.now ?? Date.now();
  const window = new Date(now).toISOString().slice(0, 10);
  const quiet = await sql<{ id: string; name: string; query: string; x_user_id: string | null; tweet_ids: string[] }[]>`
    SELECT s.id, s.name, s.config->>'query' AS query, s.config->>'xUserId' AS x_user_id, a.tweet_ids
    FROM sources s CROSS JOIN LATERAL (
      SELECT array_agg(tweet_id ORDER BY discovered_at DESC, published_at DESC NULLS LAST) AS tweet_ids, max(discovered_at) AS discovered_at FROM (
        SELECT x_post->>'tweetId' AS tweet_id, discovered_at, published_at FROM articles WHERE source_id = s.id AND x_post ? 'tweetId'
        ORDER BY discovered_at DESC, published_at DESC NULLS LAST LIMIT 3) newest) a
    WHERE s.enabled AND s.kind = 'x_search' AND s.config->>'query' ~* ${X_HANDLE.source} AND a.discovered_at < ${new Date(now - DAY_MS)}
    ORDER BY s.id`;
  const pause = () => opts.pauseMs === 0 ? null : new Promise((r) => setTimeout(r, opts.pauseMs ?? 4000));
  const renamed: XRename[] = [];
  const privateAccounts: string[] = [];
  const unknownLookups: { sourceId: string; receiptId: number }[] = [];
  let lookups = 0;
  for (const s of quiet) {
    const from = xHandle({ query: s.query })!;
    let to: string | undefined;
    let userId: string | undefined;
    for (const tweetId of s.tweet_ids) {
      if (lookups++ > 0) await pause();
      try {
        const tweet = await getTweet(tweetId, { purpose: "x_rename_check", subject: `source:${s.id}`, window });
        if (tweet) {
          // If the source already pins an immutable numeric user id, ignore a post written by anyone else.
          if (s.x_user_id && tweet.user.id_str && tweet.user.id_str !== s.x_user_id) continue;
          to = tweet.user.screen_name;
          userId = tweet.user.id_str ?? undefined;
        }
      } catch (error) {
        if (error instanceof ReceiptUnknownError && !shutdownSignal.signal.aborted) {
          // Leave the receipt to recovery before spending on another post from this account.
          unknownLookups.push({ sourceId: s.id, receiptId: error.receiptId });
        } else if (privateAccountRefusal(error)) {
          privateAccounts.push(s.id);
        } else {
          throw error;
        }
        break;
      }
      if (to) break;
    }
    if (!to) continue;
    if (to.toLowerCase() === from.toLowerCase()) {
      if (userId && !s.x_user_id) {
        await sql`UPDATE sources SET config = jsonb_set(config, '{xUserId}', to_jsonb(${userId}::text)) WHERE id = ${s.id} AND config->>'xUserId' IS NULL`;
      }
      continue;
    }
    // Only the handle is rewritten: a new display name or company alias needs judgement and is left to a person.
    const handle = new RegExp(`(from:|@)${from}(?![A-Za-z0-9_])`, "gi");
    const query = s.query.replace(handle, `$1${to}`);
    const name = s.name.replace(handle, `$1${to}`);
    await sql.begin(async (tx) => {
      if (userId) {
        await tx`UPDATE sources SET config = jsonb_set(jsonb_set(config, '{query}', to_jsonb(${query}::text)), '{xUserId}', to_jsonb(${userId}::text)), name = ${name}, updated_at = now() WHERE id = ${s.id}`;
        await tx`UPDATE articles SET x_post = jsonb_set(x_post, '{authorUserId}', to_jsonb(${userId}::text))
                 WHERE source_id = ${s.id} AND x_post IS NOT NULL AND x_post->>'authorUserId' IS NULL
                   AND lower(coalesce(x_post->>'handle', '')) = ${from.toLowerCase()}`;
      } else {
        await tx`UPDATE sources SET config = jsonb_set(config, '{query}', to_jsonb(${query}::text)), name = ${name}, updated_at = now() WHERE id = ${s.id}`;
      }
      await audit("system", "source.update", `source:${s.id}`, `X 账号 @${from} 已改名 @${to}（已存帖子作者的现名）`,
        { name: s.name, config: { query: s.query } }, { name, config: { query } }, { db: tx });
      await requestRepublish(tx, s.id, "system");
    });
    const read = await collectSource(s.id, { xSince: s.tweet_ids[0] });
    renamed.push({ sourceId: s.id, from, to, found: read.found });
  }
  return { checked: quiet.length, renamed, privateAccounts, unknownLookups };
}
