// 分片查询按信源 ID 排序，数据库行位置改变不能造成重复付费请求。
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { SourceRow } from "@aihot/backend/sources/types";

// 单连接确保测试的扫描设置与采集使用同一会话，不影响其他测试进程。
process.env.DATABASE_POOL_MAX = "1";
const { config } = await import("@aihot/backend/config");
const { closeDb, sql } = await import("@aihot/backend/db");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const { collectXShard } = await import("@aihot/backend/sources/collect");

const T = tag().slice(-10);
const NOW = Date.now();
const WATERMARK = String(BigInt(NOW) * 1000n);
const INITIAL_CURSOR = { initializedAt: new Date(NOW).toISOString(), lastTweetId: WATERMARK };
type Member = Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "enabled">;
const membersFor = (label: string): Member[] => ["A", "Z", "a"].map((suffix, i) => ({
  id: `test-xorder-${T}-${label}-${suffix}`,
  kind: "x_search",
  config: { query: `from:${label}${["z", "m", "a"][i]}${T} -filter:replies` },
  cursor: INITIAL_CURSOR,
  enabled: true,
}));
const handleOf = (m: Member) => /^from:(\w+)/.exec(m.config.query)![1]!;
const queryFor = (members: Member[], watermark = WATERMARK) =>
  `(${members.map((m) => `from:${handleOf(m)}`).join(" OR ")}) -filter:replies since_id:${watermark}`;
const queries: string[] = [];
const provider = await stub((_hit, req) => {
  queries.push(new URL(req.url, "http://stub").searchParams.get("query")!);
  return { tweets: [], next_cursor: null };
});
process.env.SOCIALDATA_BASE_URL = provider.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

async function insert(members: Member[]) {
  for (const m of members) {
    await sql`INSERT INTO pg_temp.sources (id, name, kind, config, tier, participation_mode, enabled, cursor, next_fetch_at)
      VALUES (${m.id}, ${m.id}, ${m.kind}, ${sql.json(m.config)}, 'T1', 'editorial', ${m.enabled},
              ${m.cursor ? sql.json(m.cursor) : null}, '2100-01-01')`;
  }
}

async function remove(members: Member[]) {
  const ids = members.map((m) => m.id);
  await sql`DELETE FROM pg_temp.fetch_runs WHERE source_id IN ${sql(ids)}`;
  await sql`DELETE FROM pg_temp.sources WHERE id IN ${sql(ids)}`;
}

async function resetLayout() {
  // 仅重置本会话的临时表，避免共享表空闲页使插入顺序与物理顺序不同。
  await sql`TRUNCATE pg_temp.fetch_runs, pg_temp.sources RESTART IDENTITY`;
}

async function physicalIds(members: Member[]) {
  const rows = await sql<{ id: string }[]>`SELECT id FROM pg_temp.sources WHERE id IN ${sql(members.map((m) => m.id))} ORDER BY ctid`;
  return rows.map((r) => r.id);
}

async function publicState() {
  return sql`SELECT
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text, '[]')) FROM public.sources s) AS sources,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id)::text, '[]')) FROM public.fetch_runs r) AS runs,
    last_value::text AS sequence_value, is_called FROM public.fetch_runs_id_seq`;
}

async function receiptsFor(key: string) {
  return sql<{ id: number; attempts: number; query: string; recorded_attempts: number }[]>`
    SELECT r.id, r.attempts, r.request->>'query' AS query, count(a.id)::int AS recorded_attempts
    FROM receipts r LEFT JOIN receipt_attempts a ON a.receipt_id = r.id
    WHERE r.service = 'socialdata' AND r.subject = ${`x-shard:${key}`}
    GROUP BY r.id ORDER BY r.id`;
}

let savedBudget: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
let savedPublic: Awaited<ReturnType<typeof publicState>>;
before(async () => {
  savedPublic = await publicState();
  // 复制真实迁移后的结构；LIKE 不复制外键，且原序列默认值需改为临时序列。
  await sql`CREATE TEMP TABLE pg_temp.sources (LIKE public.sources INCLUDING ALL)`;
  await sql`CREATE TEMP TABLE pg_temp.fetch_runs (LIKE public.fetch_runs INCLUDING ALL)`;
  await sql`CREATE TEMP SEQUENCE pg_temp.x_shard_fetch_run_id OWNED BY pg_temp.fetch_runs.id`;
  await sql`ALTER TABLE pg_temp.fetch_runs ALTER COLUMN id SET DEFAULT nextval('pg_temp.x_shard_fetch_run_id')`;
  await sql`ALTER TABLE pg_temp.fetch_runs ADD FOREIGN KEY (source_id) REFERENCES pg_temp.sources(id) ON DELETE CASCADE`;
  const tables = await sql`SELECT relname, relpersistence FROM pg_class
    WHERE oid IN ('sources'::regclass, 'fetch_runs'::regclass) AND relnamespace = pg_my_temp_schema() ORDER BY relname`;
  assert.deepEqual(tables.map((r) => [r.relname, r.relpersistence]), [["fetch_runs", "t"], ["sources", "t"]]);
  const [session] = await sql`SELECT pg_backend_pid() AS pid, 'sources'::regclass::oid AS sources, 'fetch_runs'::regclass::oid AS runs`;
  const [transaction] = await sql.begin((tx) => tx`SELECT pg_backend_pid() AS pid, 'sources'::regclass::oid AS sources, 'fetch_runs'::regclass::oid AS runs`);
  assert.deepEqual(transaction, session, "collection and receipt transactions use the same temporary-table session");
  savedBudget = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'socialdata'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
  // 强制真实堆扫描，避免数据库大小或执行计划碰巧掩盖无序读取。
  await sql`SET enable_indexscan = off`;
  await sql`SET enable_bitmapscan = off`;
});
beforeEach(resetLayout);
after(async () => {
  try {
    assert.deepEqual(await publicState(), savedPublic, "shared sources, fetch runs and their sequence remain unchanged");
  } finally {
    await sql`DROP TABLE IF EXISTS pg_temp.fetch_runs, pg_temp.sources`;
    const b = savedBudget[0];
    if (b) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = 'socialdata'`;
    await sql`RESET enable_indexscan`;
    await sql`RESET enable_bitmapscan`;
    await provider.close();
    await stopBoss();
    await closeDb();
  }
});

test("shard query follows source ID order despite heap, caller and handle ordering", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const members = membersFor("q");
  const ids = members.map((m) => m.id);
  t.after(() => remove(members));
  await insert([members[2]!, members[0]!, members[1]!]);
  assert.deepEqual(await physicalIds(members), [ids[2], ids[0], ids[1]]);
  const start = queries.length;
  const result = await collectXShard(`editorial:order-${T}`, [ids[2]!, ids[1]!, ids[0]!, ids[2]!]);
  assert.equal(result.status, "ok");
  assert.equal(result.accounts, 3);
  assert.deepEqual(queries.slice(start), [queryFor(members)], "source IDs use the planner's comparison, not locale or handle order");
});

test("same shard search reuses its receipt after physical row order changes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const members = membersFor("r");
  const ids = members.map((m) => m.id);
  const key = `editorial:receipt-order-${T}`;
  t.after(() => remove(members));
  await insert([members[2]!, members[0]!, members[1]!]);
  assert.deepEqual(await physicalIds(members), [ids[2], ids[0], ids[1]]);
  const start = queries.length;
  assert.equal((await collectXShard(key, ids)).status, "ok");
  const initial = await receiptsFor(key);
  assert.equal(initial.length, 1);
  assert.equal(initial[0]!.recorded_attempts, 1);

  // 只重建本会话的空响应信源，恢复完全相同的逻辑输入并改变物理位置。
  await resetLayout();
  await insert(members);
  assert.deepEqual(await physicalIds(members), ids);
  assert.equal((await collectXShard(key, [...ids].reverse())).status, "ok");
  assert.equal(queries.length - start, 1, "a row-order-only change must not call the provider again");
  assert.deepEqual(await receiptsFor(key), initial, "the original receipt and attempt must be reused");
  assert.equal(initial[0]!.query, queryFor(members));

  // 成功采集会写 lastOkAt；重试控制恢复原水位，避免引入新的搜索边界。
  await sql`UPDATE pg_temp.sources SET cursor = ${sql.json(INITIAL_CURSOR)} WHERE id IN ${sql(ids)}`;
  assert.equal((await collectXShard(key, ids)).status, "ok");
  assert.equal(queries.length - start, 1);
  assert.deepEqual(await receiptsFor(key), initial);

  const changedWatermark = String(BigInt(WATERMARK) + 1n);
  await sql`UPDATE pg_temp.sources SET cursor = ${sql.json({ ...INITIAL_CURSOR, lastTweetId: changedWatermark })} WHERE id IN ${sql(ids)}`;
  assert.equal((await collectXShard(key, ids)).status, "ok");
  assert.deepEqual(queries.slice(start), [queryFor(members), queryFor(members, changedWatermark)]);
  const changed = await receiptsFor(key);
  assert.equal(changed.length, 2, "a changed watermark is a distinct logical request");
  assert.deepEqual(changed.map((r) => [r.attempts, r.recorded_attempts]), [[1, 1], [1, 1]]);
});

test("ordering preserves disabled, incompatible, missing and empty membership controls", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const members = membersFor("e");
  const enabled = members.slice(0, 2);
  const disabled = { ...members[2]!, enabled: false };
  const fresh = { ...members[2]!, id: `${members[2]!.id}-fresh`, cursor: null };
  const custom = { ...members[2]!, id: `${members[2]!.id}-custom`, config: { query: `from:custom${T} -filter:replies keyword` } };
  const top = { ...members[2]!, id: `${members[2]!.id}-top`, config: { ...members[2]!.config, searchType: "Top" } };
  const rss = { ...members[2]!, id: `${members[2]!.id}-rss`, kind: "rss" as const };
  const ignored = [disabled, fresh, custom, top, rss];
  const all = [...enabled, ...ignored];
  const missing = `test-xorder-${T}-missing`;
  t.after(() => remove(all));
  await insert([...ignored, ...enabled].reverse());
  const start = queries.length;
  const result = await collectXShard(`editorial:eligibility-order-${T}`, [...all.map((m) => m.id), missing]);
  assert.equal(result.status, "ok");
  assert.equal(result.accounts, 2);
  assert.deepEqual(queries.slice(start), [queryFor(enabled)]);
  const runs = await sql<{ source_id: string }[]>`SELECT source_id FROM pg_temp.fetch_runs WHERE source_id IN ${sql(all.map((m) => m.id))} ORDER BY source_id`;
  assert.deepEqual(runs.map((r) => r.source_id), enabled.map((m) => m.id));
  for (const m of ignored) {
    const [row] = await sql<{ cursor: Member["cursor"] }[]>`SELECT cursor FROM pg_temp.sources WHERE id = ${m.id}`;
    assert.deepEqual(row!.cursor, m.cursor, "ineligible sources keep their original cursor");
  }
  const skipped = await collectXShard(`editorial:empty-order-${T}`, [...ignored.map((m) => m.id), missing]);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.accounts, 0);
  assert.equal(queries.length - start, 1);
  const [afterSkip] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_temp.fetch_runs WHERE source_id IN ${sql(all.map((m) => m.id))}`;
  assert.equal(afterSkip!.n, 2);

  await sql`UPDATE pg_temp.sources SET cursor = ${sql.json(INITIAL_CURSOR)} WHERE id = ${enabled[0]!.id}`;
  const single = await collectXShard(`editorial:single-order-${T}`, [enabled[0]!.id, missing]);
  assert.equal(single.status, "ok");
  assert.equal(single.accounts, 1);
  assert.equal(queries.at(-1), queryFor([enabled[0]!]));
});
