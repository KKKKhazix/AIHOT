// The grouping and its expiry must describe one read instant, even across a held query.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { beijingDate } from "@aihot/contracts/time";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `timeline-release-${T}`;
const START = Math.floor(Date.now() / 1000) * 1000;
const RELEASE = START + 2_000;
const app = await buildApp();
const ids: string[] = [];
const query = (scope: string) => ({ channel: "all" as const, category: null, tag: `${T}-${scope}`, topic: null });
const url = (scope: string) => `/api/site/timeline?tag=${T}-${scope}`;
const get = (scope: string, etag?: string) => app.inject({ method: "GET", url: url(scope), headers: etag ? { "if-none-match": etag } : {} });
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Release fixture', 'rss', 'T1')`;
});
after(async () => {
  await app.close();
  if (ids.length) await sql`DELETE FROM articles WHERE id IN ${sql(ids)}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await closeDb();
});
async function item(scope: string, release = RELEASE) {
  const id = `${T}-${scope}-${ids.length}`;
  ids.push(id);
  const at = new Date(START);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${SOURCE}, ${id}, 'https://example.test/release', ${id}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, tags)
    VALUES (${id}, ${id}, ${SOURCE}, 'news', 'https://example.test/release', ${at}, ${at}, ${at}, true, true, ${new Date(release)}, 'public', ${[query(scope).tag]})`;
  return id;
}
function bounded(headers: Record<string, unknown>, deadline: number) {
  assert.doesNotMatch(String(headers["cache-control"]), /stale/);
  for (const [, seconds] of String(headers["cache-control"]).matchAll(/(?:^|[, ])(?:max-age|s-maxage)=(\d+)/g)) {
    assert.ok(Date.now() + Number(seconds) * 1000 <= deadline);
  }
  const expires = String(headers["x-accel-expires"]);
  assert.ok(expires === "0" || (expires.startsWith("@") && Number(expires.slice(1)) * 1000 <= deadline));
}

test("a warm timeline releases cards, day counts and ETags at the exact boundary", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const id = await item("boundary");
  await item("unrelated", RELEASE + 20_000);
  const before = await get("boundary");
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.json().cards, []);
  assert.equal(before.json().refreshAt, new Date(RELEASE).toISOString());
  bounded(before.headers, RELEASE);
  t.mock.timers.setTime(RELEASE - 1);
  const unchanged = await get("boundary", String(before.headers.etag));
  assert.equal(unchanged.statusCode, 304);
  bounded(unchanged.headers, RELEASE);
  for (const at of [RELEASE, RELEASE + 1]) {
    t.mock.timers.setTime(at);
    const response = await get("boundary", String(before.headers.etag));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().cards.map((c: any) => c.item.id), [id]);
    assert.deepEqual(response.json().dayCounts, { [beijingDate(START)]: 1 });
    assert.equal(response.json().refreshAt, null, "unrelated filters do not shorten this scope");
  }
  const historical = await loadTimeline({ ...query("boundary"), now: new Date(RELEASE - 1) });
  assert.deepEqual(historical.cards, []);
  assert.equal(historical.refreshAt, new Date(RELEASE).toISOString());
  const current = await get("boundary");
  assert.deepEqual(current.json().cards.map((c: any) => c.item.id), [id], "historical reads do not replace shared cache");
});

test("post-release readers do not inherit an expired in-flight grouping", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const id = await item("inflight");
  const locked = gate();
  const unlock = gate();
  const blocker = sql.begin(async tx => {
    await tx`LOCK TABLE publications IN ACCESS EXCLUSIVE MODE`;
    locked.open();
    await unlock.promise;
  });
  await locked.promise;
  let before: ReturnType<typeof loadTimeline> | undefined;
  let afterRelease: ReturnType<typeof loadTimeline> | undefined;
  try {
    before = loadTimeline(query("inflight"));
    // Wait for the actual old-time grouping query, not a wall-clock delay.
    let waiting = false;
    const waitUntil = performance.now() + 5000;
    while (performance.now() < waitUntil) {
      const rows = await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%WITH base AS%'`;
      if (rows.length) { waiting = true; break; }
      await setTimeout(10);
    }
    assert.ok(waiting, "grouping query is waiting behind our isolated table lock");
    t.mock.timers.setTime(RELEASE);
    afterRelease = loadTimeline(query("inflight"));
    await setImmediate();
  } finally {
    unlock.open();
    await blocker;
  }
  const [old, current] = await Promise.all([before!, afterRelease!]);
  assert.deepEqual(old.cards, []);
  assert.equal(old.refreshAt, new Date(RELEASE).toISOString(), "a slow old read keeps its expired deadline");
  assert.deepEqual(current.cards.map(c => c.item.id), [id]);
  assert.equal(current.refreshAt, null);
});

test("an expired grouping is not served when refresh fails", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const id = await item("failure");
  await loadTimeline(query("failure"));
  t.mock.timers.setTime(RELEASE);
  const hidden = `publications_${T}`;
  await sql`ALTER TABLE publications RENAME TO ${sql(hidden)}`;
  try {
    await assert.rejects(loadTimeline(query("failure")));
  } finally {
    await sql`ALTER TABLE ${sql(hidden)} RENAME TO publications`;
  }
  assert.deepEqual((await loadTimeline(query("failure"))).cards.map(c => c.item.id), [id]);
});
