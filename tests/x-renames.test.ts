// An X account renamed under us: a search by the old handle finds nothing and still succeeds, so the
// account only looks quiet. Accounts quiet for a day are looked up by their newest stored post; a new
// author handle replaces the old one in the source, and the posts since that post are read at once.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { republishKey } from "@aihot/backend/jobs/publication";
import { followXRenames } from "@aihot/backend/sources/x-renames";
import { ProviderRejectedError } from "@aihot/backend/providers/receipts";

const DAY = 86400_000;
const PRIVATE_MESSAGE = "Forbidden: Requested resource cannot be viewed due to user's privacy settings";
let privateResponse = { status: 403, message: PRIVATE_MESSAGE };
let unknownLookup: string | undefined;
/** Every stored post the provider knows: who wrote it now (null when it is gone), or "private". */
const authors = new Map<string, string | null>();
/** Posts made after a rename, by their new handle. */
const later: Array<{ id: string; handle: string }> = [];
const lookups: string[] = [];
const searches: string[] = [];
const socialdata = await stub((_hit, req) => {
  const url = new URL(req.url, "http://stub");
  const lookup = /^\/twitter\/tweets\/(\d+)$/.exec(url.pathname);
  if (lookup) {
    lookups.push(lookup[1]!);
    if (lookup[1] === unknownLookup) return new Reply(200, undefined);
    const author = authors.get(lookup[1]!);
    if (author === "private") return new Reply(privateResponse.status, { status: "error", message: privateResponse.message });
    if (!author) return new Reply(404, { status: "error", message: "Tweet not found" });
    return { id_str: lookup[1], tweet_created_at: new Date().toISOString(), full_text: "old post", user: { name: "x", screen_name: author } };
  }
  const q = url.searchParams.get("query") ?? "";
  searches.push(q);
  const handles = new Set([...q.matchAll(/from:(\w+)/g)].map((m) => m[1]!.toLowerCase()));
  const since = BigInt(/since_id:(\d+)/.exec(q)?.[1] ?? "0");
  const tweets = later.filter((p) => handles.has(p.handle.toLowerCase()) && BigInt(p.id) > since).reverse()
    .map((p) => ({ id_str: p.id, tweet_created_at: new Date().toISOString(), full_text: `Later post ${p.id}`, lang: "en", user: { name: p.handle, screen_name: p.handle } }));
  return { tweets, next_cursor: null };
});
process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
});
after(async () => {
  await socialdata.close();
  await stopBoss();
  await closeDb();
});

/**
 * One test's accounts: the stored query and name, and the stored posts, newest first — age in days and
 * who wrote it now (null when the post is gone, "private" for a private account). The rename check reads
 * every quiet account, so an earlier test's accounts are removed first.
 */
async function accounts() {
  await sql`DELETE FROM articles WHERE source_id LIKE 'test-xr-%'`;
  await sql`DELETE FROM sources WHERE id LIKE 'test-xr-%'`;
  const T = tag();
  const base = BigInt(Date.now() - 3 * DAY - 1288834974657) << 22n;
  const tid = (n: number) => String(base + BigInt(n));
  const h = (name: string) => `${name}${T}`.slice(0, 15);
  const post = (n: number, ageDays: number, now: string | null) => ({ n, ageDays, now });
  const all = {
    aa_private: { query: `from:${h("private")} -filter:replies`, name: "Private account", posts: [post(54, 3, "private"), post(55, 4, null)] },
    renamed: { query: `from:${h("olda")} -filter:replies`, name: `X：A (@${h("olda")})`, posts: [post(1, 3, h("newa"))] },
    keywords: { query: `from:${h("oldf")} -filter:replies (Grok OR xAI)`, name: `X：F (@${h("oldf")})`, posts: [post(2, 3, h("newf"))] },
    // The newest post was deleted; an older one still names the account.
    olderpost: { query: `from:${h("oldg")} -filter:replies`, name: `X：G (@${h("oldg")})`, posts: [post(7, 3, null), post(8, 5, h("newg"))] },
    recased: { query: `from:${h("caseb")} -filter:replies`, name: `X：B (@${h("caseb")})`, posts: [post(3, 3, h("caseb").toUpperCase())] },
    active: { query: `from:${h("livec")} -filter:replies`, name: `X：C (@${h("livec")})`, posts: [post(4, 0.1, h("newc"))] },
    deleted: { query: `from:${h("gone")} -filter:replies`, name: `X：D (@${h("gone")})`, posts: [post(5, 3, null), post(51, 4, null), post(52, 5, null), post(53, 6, null)] },
    paused: { query: `from:${h("pause")} -filter:replies`, name: `X：E (@${h("pause")})`, posts: [post(6, 3, h("newe"))] },
  };
  type Key = keyof typeof all;
  const id = (k: Key) => `test-xr-${k}-${T}`;
  const watermark = tid(900);
  for (const [k, a] of Object.entries(all) as Array<[Key, (typeof all)[Key]]>) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, cursor, next_fetch_at)
              VALUES (${id(k)}, ${a.name}, 'x_search', ${sql.json({ query: a.query, searchType: "Latest" })}, 'T1_5', 'editorial', ${k !== "paused"},
                      ${sql.json({ initializedAt: new Date(Date.now() - 30 * DAY).toISOString(), lastTweetId: watermark, lastOkAt: new Date(Date.now() - 5 * 60_000).toISOString() })}, '2100-01-01')`;
    const handle = /from:(\w+)/.exec(a.query)![1]!;
    for (const p of a.posts) {
      authors.set(tid(p.n), p.now);
      const at = new Date(Date.now() - p.ageDays * DAY);
      await sql`INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at, x_post)
                VALUES (${`xr-${p.n}-${T}`}, ${id(k)}, ${`x:${tid(p.n)}`}, ${`https://x.com/${handle}/status/${tid(p.n)}`}, 'old post', ${at}, ${at}, ${at},
                        ${sql.json({ tweetId: tid(p.n), handle, authorName: handle, text: "old post" })})`;
    }
  }
  // Posted after the rename, newer than the newest stored post, by the renamed accounts.
  later.push({ id: tid(10), handle: h("newa") }, { id: tid(11), handle: h("newa") }, { id: tid(12), handle: h("newf") }, { id: tid(13), handle: h("newg") });
  const source = async (k: Key) => (await sql<{ name: string; config: { query: string }; cursor: { lastTweetId: string } }[]>`
    SELECT name, config, cursor FROM sources WHERE id = ${id(k)}`)[0]!;
  return { all, id, h, tid, watermark, source, newest: (k: Key) => tid(all[k].posts[0]!.n) };
}

test("a quiet account under a new handle is followed, and its posts since the newest stored one are read", async () => {
  const { all, id, h, tid, watermark, source, newest } = await accounts();
  const result = await followXRenames({ pauseMs: 0 });
  assert.deepEqual(result.renamed.map((r) => [r.sourceId, r.from, r.to]).sort(), [
    [id("keywords"), h("oldf"), h("newf")], [id("olderpost"), h("oldg"), h("newg")], [id("renamed"), h("olda"), h("newa")],
  ].sort());

  assert.deepEqual(result.privateAccounts, [id("aa_private")]);
  assert.equal(result.checked, 6, "all quiet accounts are attempted, with private ones reported separately");
  const privateAccount = await source("aa_private");
  assert.deepEqual([privateAccount.name, privateAccount.config.query], [all.aa_private.name, all.aa_private.query]);
  assert.ok(!lookups.includes(tid(55)), "a private account does not spend lookups on older posts");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject = ${`source:${id("aa_private")}`}`).length, 0, "no identity is changed without readable evidence");
  const [refusal] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE purpose = 'x_rename_check' AND subject = ${`source:${id("aa_private")}`}`;
  assert.equal(refusal?.status, "failed", "the actual refusal remains recorded");

  const a = await source("renamed");
  assert.equal(a.config.query, `from:${h("newa")} -filter:replies`);
  assert.equal(a.name, `X：A (@${h("newa")})`, "the name names the account by its new handle");
  assert.equal((await source("keywords")).config.query, `from:${h("newf")} -filter:replies (Grok OR xAI)`, "the rest of a query stays");

  const [audited] = await sql<{ actor: string; reason: string; before: { config: { query: string } }; after: { config: { query: string } } }[]>`
    SELECT actor, reason, before, after FROM audit_log WHERE subject = ${`source:${id("renamed")}`} AND action = 'source.update'`;
  assert.equal(audited!.actor, "system");
  assert.ok(audited!.reason.includes(`@${h("olda")}`) && audited!.reason.includes(`@${h("newa")}`));
  assert.deepEqual([audited!.before.config.query, audited!.after.config.query], [all.renamed.query, a.config.query]);
  const [queued] = await sql<{ value: { status: string } }[]>`SELECT value FROM settings WHERE key = ${republishKey(id("renamed"))}`;
  assert.equal(queued?.value.status, "queued", "public rows carrying the source name are re-derived");

  assert.ok(searches.some((q) => q.includes(`from:${h("newa")}`) && q.endsWith(`since_id:${newest("renamed")}`)), "read again from the newest stored post");
  assert.ok(searches.some((q) => q.includes(`from:${h("newg")}`) && q.endsWith(`since_id:${newest("olderpost")}`)), "also when an older post named the account");
  const stored = await sql<{ source_id: string; n: number }[]>`
    SELECT source_id, count(*)::int AS n FROM articles WHERE source_id IN ${sql([id("renamed"), id("keywords")])} GROUP BY 1`;
  assert.deepEqual(Object.fromEntries(stored.map((r) => [r.source_id, r.n])), { [id("renamed")]: 3, [id("keywords")]: 2 }, "posts made after the rename are collected");
  assert.equal((await source("olderpost")).config.query, `from:${h("newg")} -filter:replies`);
  assert.equal(a.cursor.lastTweetId, watermark, "reading again does not move the shard's coverage back");
});

test("accounts that still post, keep their handle in another case, lost their posts or are paused stay as they are", async () => {
  const { all, tid, source, newest } = await accounts();
  await followXRenames({ pauseMs: 0 });
  for (const k of ["recased", "active", "deleted", "paused"] as const) {
    const s = await source(k);
    assert.deepEqual([s.config.query, s.name], [all[k].query, all[k].name], k);
  }
  assert.ok(lookups.includes(newest("recased")), "quiet accounts are looked up");
  assert.deepEqual(all.deleted.posts.map((p) => lookups.filter((l) => l === tid(p.n)).length), [1, 1, 1, 0], "the three newest stored posts at most");
  assert.ok(!lookups.includes(newest("active")), "an account with a post in the last day proves its handle");
  assert.ok(!lookups.includes(newest("paused")), "paused accounts are not looked up");
});

test("a quiet account is looked up again the next day, not answered from the day before", async () => {
  const { newest } = await accounts();
  const looked = () => lookups.filter((l) => l === newest("recased")).length;
  await followXRenames({ pauseMs: 0 });
  assert.equal(looked(), 1);
  await followXRenames({ pauseMs: 0 });
  assert.equal(looked(), 1, "the same day reuses the answer");
  await followXRenames({ now: Date.now() + DAY, pauseMs: 0 });
  assert.equal(looked(), 2);
});

test("a lost lookup is reported without trying another post or stopping other accounts", async () => {
  const { all, id, h, tid, source, newest } = await accounts();
  unknownLookup = newest("aa_private");
  const from = lookups.length;
  try {
    const result = await followXRenames({ pauseMs: 0 });
    const [receipt] = await sql<{ id: number; status: string; attempts: number }[]>`
      SELECT id, status, attempts FROM receipts WHERE purpose = 'x_rename_check' AND subject = ${`source:${id("aa_private")}`}`;
    assert.ok(receipt);
    assert.deepEqual([receipt.status, receipt.attempts], ["unknown", 1]);
    assert.deepEqual(result.unknownLookups, [{ sourceId: id("aa_private"), receiptId: receipt.id }]);
    assert.deepEqual(result.privateAccounts, []);
    assert.equal((await source("aa_private")).config.query, all.aa_private.query);
    assert.ok(!lookups.slice(from).includes(tid(55)), "an unknown outcome is not retried with an older post");
    assert.equal((await source("renamed")).config.query, `from:${h("newa")} -filter:replies`);
  } finally { unknownLookup = undefined; }
});

test("other permission refusals and provider failures still fail the rename check", async () => {
  await accounts();
  try {
    for (const [index, failure] of [
      { status: 403, message: "Forbidden: account permission required" },
      { status: 401, message: PRIVATE_MESSAGE },
      { status: 429, message: "Rate limit exceeded" },
      { status: 503, message: "Service unavailable" },
    ].entries()) {
      privateResponse = failure;
      await assert.rejects(followXRenames({ now: Date.now() + index * DAY, pauseMs: 0 }),
        (error: unknown) => error instanceof ProviderRejectedError && error.status === failure.status);
    }
  } finally { privateResponse = { status: 403, message: PRIVATE_MESSAGE }; }
});
