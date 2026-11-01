// X accounts renamed under us. A search by the old handle finds nothing and still succeeds, so a
// renamed account only looks quiet. Every account quiet for a day is looked up by a stored post, whose
// author is the same account under its current handle (the newest post that still exists, of the last
// three: authors delete posts); a new handle replaces the old one in the source, and the account is read
// again from its newest stored post, so nothing posted since is missed.
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { requestRepublish } from "../jobs/publication.ts";
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
export async function followXRenames(opts: { now?: number; pauseMs?: number } = {}): Promise<{ checked: number; renamed: XRename[]; privateAccounts: string[] }> {
  const now = opts.now ?? Date.now();
  const window = new Date(now).toISOString().slice(0, 10);
  const quiet = await sql<{ id: string; name: string; query: string; tweet_ids: string[] }[]>`
    SELECT s.id, s.name, s.config->>'query' AS query, a.tweet_ids
    FROM sources s CROSS JOIN LATERAL (
      SELECT array_agg(tweet_id ORDER BY discovered_at DESC, published_at DESC NULLS LAST) AS tweet_ids, max(discovered_at) AS discovered_at FROM (
        SELECT x_post->>'tweetId' AS tweet_id, discovered_at, published_at FROM articles WHERE source_id = s.id AND x_post ? 'tweetId'
        ORDER BY discovered_at DESC, published_at DESC NULLS LAST LIMIT 3) newest) a
    WHERE s.enabled AND s.kind = 'x_search' AND s.config->>'query' ~* ${X_HANDLE.source} AND a.discovered_at < ${new Date(now - DAY_MS)}
    ORDER BY s.id`;
  const pause = () => opts.pauseMs === 0 ? null : new Promise((r) => setTimeout(r, opts.pauseMs ?? 4000));
  const renamed: XRename[] = [];
  const privateAccounts: string[] = [];
  let lookups = 0;
  for (const s of quiet) {
    const from = xHandle({ query: s.query })!;
    let to: string | undefined;
    for (const tweetId of s.tweet_ids) {
      if (lookups++ > 0) await pause();
      try {
        to = (await getTweet(tweetId, { purpose: "x_rename_check", subject: `source:${s.id}`, window }))?.user.screen_name;
      } catch (error) {
        // The refusal stays on its receipt; the unverified account is reported and the others go on.
        if (!privateAccountRefusal(error)) throw error;
        privateAccounts.push(s.id);
        break;
      }
      if (to) break;
    }
    if (!to || to.toLowerCase() === from.toLowerCase()) continue;
    // Only the handle is rewritten: a new display name or company alias needs judgement and is left to a person.
    const handle = new RegExp(`(from:|@)${from}(?![A-Za-z0-9_])`, "gi");
    const query = s.query.replace(handle, `$1${to}`);
    const name = s.name.replace(handle, `$1${to}`);
    await sql.begin(async (tx) => {
      await tx`UPDATE sources SET config = jsonb_set(config, '{query}', to_jsonb(${query}::text)), name = ${name}, updated_at = now() WHERE id = ${s.id}`;
      await audit("system", "source.update", `source:${s.id}`, `X 账号 @${from} 已改名 @${to}（已存帖子作者的现名）`,
        { name: s.name, config: { query: s.query } }, { name, config: { query } }, { db: tx });
      await requestRepublish(tx, s.id, "system");
    });
    const read = await collectSource(s.id, { xSince: s.tweet_ids[0] });
    renamed.push({ sourceId: s.id, from, to, found: read.found });
  }
  return { checked: quiet.length, renamed, privateAccounts };
}
