// X accounts share searches: one request reads a shard of accounts, each post goes to
// the source whose handle wrote it, every account keeps its own fetch run and watermark, and a failed
// search moves no watermark.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource, collectXShard, scheduleDueSources } from "@aihot/backend/sources/collect";
import { planXShards, shardQuery, selfThreadHandle, fetchXSearch } from "@aihot/backend/sources/x";

const T = tag();
const HANDLES = [`sa${T}`, `sb${T}`, `sc${T}`];
const IDS = HANDLES.map((h) => `test-xs-${h}`);
const BASE = BigInt(Date.now()) * 1000n;
const WATERMARK = BASE + 100n;
// Newer than the watermark: three posts by the first account, one by the second, none by the third.
const POSTS = [
  { id: BASE + 104n, handle: HANDLES[0]! },
  { id: BASE + 103n, handle: HANDLES[1]! },
  { id: BASE + 102n, handle: HANDLES[0]! },
  { id: BASE + 101n, handle: HANDLES[0]! },
];
const tweet = (p: { id: bigint; handle: string }) => ({
  id_str: String(p.id), tweet_created_at: new Date().toISOString(), full_text: `Post ${p.id} ${T}`, lang: "en", user: { name: p.handle, screen_name: p.handle },
});

let failNext = false;
let failPage2 = 0;
const queries: string[] = [];
const socialdata = await stub((_hit, req) => {
  const q = new URL(req.url, "http://stub").searchParams.get("query") ?? "";
  queries.push(q);
  if (failNext) {
    failNext = false;
    return new Reply(500, { error: "down" });
  }
  const handles = new Set([...q.matchAll(/from:(\w+)/g)].map((m) => m[1]!.toLowerCase()));
  const since = BigInt(/since_id:(\d+)/.exec(q)?.[1] ?? "0");
  // Two posts a page; `cursor` is the page number.
  const page = Number(new URL(req.url, "http://stub").searchParams.get("cursor") ?? 0);
  if (page === 1 && failPage2 > 0) {
    failPage2 -= 1;
    return new Reply(500, { error: "slow" });
  }
  const ids = POSTS.filter((p) => handles.has(p.handle.toLowerCase()) && p.id > since);
  return { tweets: ids.slice(page * 2, page * 2 + 2).map(tweet), next_cursor: (page + 1) * 2 < ids.length ? String(page + 1) : null };
});
process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

const cursorOf = async (id: string) => (await sql<{ cursor: { lastTweetId: string } }[]>`SELECT cursor FROM sources WHERE id = ${id}`)[0]!.cursor;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
  for (const [i, id] of IDS.entries()) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
              VALUES (${id}, ${HANDLES[i]!}, 'x_search', ${sql.json({ query: `from:${HANDLES[i]!} -filter:replies`, searchType: "Latest" })}, 'T1', 'editorial',
                      ${sql.json({ initializedAt: new Date().toISOString(), lastTweetId: String(WATERMARK) })}, '2100-01-01')`;
  }
});
after(async () => {
  await socialdata.close();
  await stopBoss();
  await closeDb();
});

test("shards keep to the query length and account limits, per participation mode", () => {
  const long = Array.from({ length: 60 }, (_, i) => ({
    id: `s${String(i).padStart(2, "0")}`, kind: "x_search" as const, participation_mode: (i % 2 ? "hot_signal" : "editorial") as "hot_signal" | "editorial",
    config: { query: `from:handle_${String(i).padStart(8, "0")} -filter:replies`, ...(i % 3 === 0 ? { publisherRole: "organization" } : {}) }, cursor: { lastTweetId: "1" },
  }));
  const own = { id: "s99", kind: "x_search" as const, participation_mode: "editorial" as const, config: { query: "from:elonmusk -filter:replies (Grok OR xAI)" }, cursor: { lastTweetId: "1" } };
  const fresh = { id: "s98", kind: "x_search" as const, participation_mode: "editorial" as const, config: { query: "from:newaccount -filter:replies" }, cursor: null };
  const shards = planXShards([...long, own, fresh]);
  assert.deepEqual(shards.flatMap((s) => s.sourceIds).sort(), long.map((s) => s.id).sort(), "a query of its own and a first fetch stay out");
  for (const s of shards) {
    const handles = s.sourceIds.map((id) => /handle_\d+/.exec(long.find((l) => l.id === id)!.config.query)![0]);
    assert.ok(shardQuery(handles, s.sourceIds.map((id) => selfThreadHandle(long.find((l) => l.id === id)!)).filter((h): h is string => h !== null)).length <= 470, "room is left for the since_id watermark under 512 characters");
    assert.ok(s.sourceIds.length <= 24);
    assert.ok(s.sourceIds.every((id) => long.find((l) => l.id === id)!.participation_mode === s.mode), "modes are not mixed");
  }
  assert.deepEqual(planXShards([...long].reverse()).map((s) => s.key), shards.map((s) => s.key), "the same sources give the same shards");
});

test("one search reads a shard; each account gets its own posts, run and watermark", async () => {
  const before = queries.length;
  const res = await collectXShard(`editorial:test-${T}`, IDS);
  assert.equal(res.status, "ok");
  const asked = queries.slice(before);
  assert.equal(asked.length, 2, "one search for three accounts (two pages of posts)");
  for (const q of asked) assert.match(q, new RegExp(`^\\(from:${HANDLES[0]} OR from:${HANDLES[1]} OR from:${HANDLES[2]}\\) -filter:replies since_id:${WATERMARK}$`));
  const stored = await sql<{ source_id: string; n: number }[]>`SELECT source_id, count(*)::int AS n FROM articles WHERE source_id IN ${sql(IDS)} GROUP BY 1`;
  assert.deepEqual(Object.fromEntries(stored.map((r) => [r.source_id, r.n])), { [IDS[0]!]: 3, [IDS[1]!]: 1 });
  for (const id of IDS) assert.equal((await cursorOf(id)).lastTweetId, String(BASE + 104n), "every account is covered up to the newest post read");
  const runs = await sql<{ source_id: string; status: string; found_count: number; detail: { shard: string; accounts: number } }[]>`
    SELECT DISTINCT ON (source_id) source_id, status, found_count, detail FROM fetch_runs WHERE source_id IN ${sql(IDS)} ORDER BY source_id, id DESC`;
  assert.deepEqual(runs.map((r) => [r.status, r.found_count, r.detail.accounts]), [["ok", 3, 3], ["ok", 1, 3], ["ok", 0, 3]]);
  const [next] = await sql<{ minutes: number; interval: number }[]>`SELECT round(extract(epoch FROM next_fetch_at - now()) / 60)::int AS minutes, interval_minutes AS interval FROM sources WHERE id = ${IDS[2]!}`;
  assert.deepEqual([next!.minutes, next!.interval], [30, 30], "editorial shards are read every half hour");
});

test("a page failing after the first keeps what was read and goes on from there next run", async () => {
  // Another watermark (still below every post): paid responses are reused only for the same search.
  await sql`UPDATE sources SET cursor = (cursor - 'lastOkAt') || ${sql.json({ lastTweetId: String(WATERMARK - 1n) })} WHERE id IN ${sql(IDS)}`;
  await sql`DELETE FROM articles WHERE source_id IN ${sql(IDS)}`;
  failPage2 = 2; // the page, and the same run's second try at it from the stretch kept
  const first = await collectXShard(`editorial:test-${T}`, IDS);
  assert.equal(first.status, "ok", "the accounts are not failed for a later page");
  assert.equal(first.found, 2, "the first page is kept");
  const cursor = (await sql<{ cursor: { lastTweetId: string; xBacklog?: unknown[] } }[]>`SELECT cursor FROM sources WHERE id = ${IDS[2]!}`)[0]!.cursor;
  assert.equal(cursor.lastTweetId, String(BASE + 104n), "the watermark moves to the newest post read");
  assert.equal(cursor.xBacklog?.length, 1, "the rest is kept to read");
  const partial = await sql`SELECT status FROM receipts WHERE subject = ${`x-shard:editorial:test-${T}`}
    AND request->>'query' LIKE ${`%since_id:${WATERMARK - 1n}`} ORDER BY id`;
  assert.deepEqual(partial.map((r) => r.status), ["completed", "failed"], "only received pages complete; a failed page remains retryable");
  const second = await collectXShard(`editorial:test-${T}`, IDS);
  assert.equal(second.found, 2, "the next run reads the rest");
  const stored = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id IN ${sql(IDS)}`;
  assert.equal(stored[0]!.n, 4, "no post between the old watermark and the newest is lost");
});

test("a quiet account's old newest post does not drag the shard's search back: its last check does", async () => {
  const checked = Date.now() - 45 * 60_000;
  await sql`UPDATE sources SET cursor = cursor || ${sql.json({ lastTweetId: String(WATERMARK - 3n), lastOkAt: new Date(checked).toISOString() })} WHERE id IN ${sql(IDS)}`;
  await sql`UPDATE sources SET cursor = cursor || ${sql.json({ lastTweetId: "1000" })} WHERE id = ${IDS[2]!}`;
  const before = queries.length;
  await collectXShard(`editorial:test-${T}`, IDS);
  const since = BigInt(/since_id:(\d+)/.exec(queries[before]!)![1]!);
  const expected = (BigInt(checked - 10 * 60_000 - 1288834974657) << 22n);
  assert.equal(since, expected > WATERMARK - 3n ? expected : WATERMARK - 3n, "bounded by the last checks, not by the quiet account's post");
});

test("a failed search fails every account of the shard and moves no watermark", async () => {
  await sql`UPDATE sources SET cursor = (cursor - 'lastOkAt') || ${sql.json({ lastTweetId: String(WATERMARK - 2n) })} WHERE id IN ${sql(IDS)}`;
  const watermark = String(WATERMARK - 2n);
  failNext = true;
  const res = await collectXShard(`editorial:test-${T}`, IDS);
  assert.equal(res.status, "failed");
  for (const id of IDS) assert.equal((await cursorOf(id)).lastTweetId, watermark);
  const failed = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (source_id) status FROM fetch_runs WHERE source_id IN ${sql(IDS)} ORDER BY source_id, id DESC) r WHERE status = 'failed'`;
  assert.equal(failed[0]!.n, 3);
});

test("due accounts are scheduled by shard, not one by one", async () => {
  await sql`UPDATE sources SET next_fetch_at = now() - interval '1 minute' WHERE id = ${IDS[1]!}`;
  await scheduleDueSources();
  const jobs = await sql<{ name: string; data: { sourceId?: string; sourceIds?: string[] } }[]>`
    SELECT name, data FROM pgboss.job WHERE created_on > now() - interval '1 minute' AND (data->>'sourceId' IN ${sql(IDS)} OR data->'sourceIds' ?| ${IDS})`;
  assert.equal(jobs.filter((j) => j.name === "sources.fetch").length, 0, "no account of a shard is fetched on its own");
  const shard = jobs.find((j) => j.name === "sources.fetch-x");
  assert.ok(shard, "the shard with the due account is enqueued");
  assert.ok(IDS.every((id) => jobs.some((j) => j.data.sourceIds?.includes(id))), "all its accounts are read together");
});


test("verified publishers include self-thread announcements in both single and shared searches", async () => {
  await sql`UPDATE sources SET config = config || '{"publisherRole":"organization"}'::jsonb,
    cursor = (cursor - 'lastOkAt') || ${sql.json({ lastTweetId: String(WATERMARK - 8n) })} WHERE id = ${IDS[0]!}`;
  const before = queries.length;
  await collectXShard(`editorial:self-threads-${T}`, IDS);
  const q = queries[before]!;
  assert.ok(q.includes(`OR (from:${HANDLES[0]}) filter:self_threads)`), "only the verified publisher gets thread continuations");
  assert.ok(q.includes(`(from:${HANDLES[0]} OR from:${HANDLES[1]} OR from:${HANDLES[2]}) -filter:replies`));
  const [source] = await sql`SELECT * FROM sources WHERE id = ${IDS[0]!}`;
  const singleBefore = queries.length;
  await fetchXSearch(source as Parameters<typeof fetchXSearch>[0]);
  assert.ok(queries[singleBefore]!.startsWith(`from:${HANDLES[0]} (-filter:replies OR filter:self_threads)`));
  assert.equal(selfThreadHandle({ config: { query: "from:official -filter:replies", publisherRole: "person" } }), "official");
  assert.equal(selfThreadHandle({ config: { query: "from:official -filter:replies (AI OR news)", publisherRole: "organization" } }), null, "custom query semantics stay explicit");
  assert.equal(selfThreadHandle({ config: { query: "from:media -filter:replies" } }), null);
});

// Storage may fail after a paid page arrived and another member was stored. The shard must close
// every run, preserve all watermarks and replay the saved response instead of leaving phantom runs.
test("a shard storage failure closes all runs without advancing its coverage", async () => {
  const watermark = String(WATERMARK - 20n);
  await sql`UPDATE sources SET cursor = (cursor - 'lastOkAt' - 'xBacklog') || ${sql.json({ lastTweetId: watermark })} WHERE id IN ${sql(IDS)}`;
  await sql`DELETE FROM articles WHERE source_id IN ${sql(IDS)}`;
  await sql.unsafe(`CREATE FUNCTION fail_shard_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id = '${IDS[1]}' THEN RAISE EXCEPTION 'injected storage failure'; END IF;
    RETURN NEW; END $$`);
  await sql`CREATE TRIGGER fail_shard_storage BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION fail_shard_storage()`;
  let result;
  try { result = await collectXShard(`editorial:storage-${T}`, IDS); }
  finally { await sql`DROP TRIGGER fail_shard_storage ON articles`; await sql`DROP FUNCTION fail_shard_storage()`; }
  assert.equal(result.status, "failed");
  for (const id of IDS) assert.equal((await cursorOf(id)).lastTweetId, watermark);
  const runs = await sql`SELECT DISTINCT ON(source_id) status FROM fetch_runs WHERE source_id IN ${sql(IDS)} ORDER BY source_id,id DESC`;
  assert.ok(runs.every(r => r.status === "failed"), "no completed or permanently running member of the failed shard");
  const hits = socialdata.hits();
  assert.equal((await collectXShard(`editorial:storage-${T}`, IDS)).status, "ok");
  assert.equal(socialdata.hits(), hits, "retry reuses the received pages");
  assert.equal((await sql`SELECT id FROM articles WHERE source_id IN ${sql(IDS)}`).length, POSTS.length);
});

test("paid search receipts and coverage commit together for single sources and shards", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const [i, kind] of ["single", "shard"].entries()) {
    const watermark = String(WATERMARK - 30n - BigInt(i));
    const key = `editorial:commit-${T}`;
    const subject = kind === "single" ? `source:${IDS[0]}` : `x-shard:${key}`;
    const ids = kind === "single" ? [IDS[0]!] : IDS;
    const collect = () => kind === "single" ? collectSource(IDS[0]!, { force: true }) : collectXShard(key, IDS);
    await sql`UPDATE sources SET cursor = (cursor - 'lastOkAt' - 'xBacklog') || ${sql.json({ lastTweetId: watermark })} WHERE id IN ${sql(ids)}`;
    await sql.unsafe(`CREATE FUNCTION fail_coverage_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status = 'ok' THEN RAISE EXCEPTION 'injected coverage failure'; END IF;
      RETURN NEW; END $$`);
    await sql`CREATE TRIGGER fail_coverage_commit BEFORE UPDATE ON fetch_runs FOR EACH ROW EXECUTE FUNCTION fail_coverage_commit()`;
    try { assert.equal((await collect()).status, "failed"); }
    finally { await sql`DROP TRIGGER fail_coverage_commit ON fetch_runs`; await sql`DROP FUNCTION fail_coverage_commit()`; }
    const pending = await sql`SELECT status, completed_at FROM receipts WHERE subject = ${subject} AND request->>'query' LIKE ${`%since_id:${watermark}`}`;
    assert.equal(pending.length, 2);
    assert.ok(pending.every((r) => r.status === "received" && r.completed_at === null));
    for (const id of ids) assert.equal((await cursorOf(id)).lastTweetId, watermark, `${kind} rolls back its coverage`);
    const hits = socialdata.hits();
    assert.equal((await collect()).status, "ok");
    assert.equal(socialdata.hits(), hits, `${kind} reuses the saved pages after a database failure`);
    const completed = await sql`SELECT status, completed_at FROM receipts WHERE subject = ${subject} AND request->>'query' LIKE ${`%since_id:${watermark}`}`;
    assert.ok(completed.every((r) => r.status === "completed" && r.completed_at !== null));
  }
});
