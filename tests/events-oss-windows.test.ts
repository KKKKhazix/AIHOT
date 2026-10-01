import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { backfillStoryHeat, computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import type { HotEntry } from "@aihot/backend/events/hot";

const prefix = `hotwindows-${tag()}`;
const hour = 3_600_000;
const at = new Date(Math.floor(Date.now() / hour) * hour);
const ago = (hours: number) => new Date(at.getTime() - hours * hour);
const storyIds: number[] = [];
const rankingIds: number[] = [];
let serial = 0;

interface Evidence {
  participant: string;
  hours: number;
  kind?: "editorial" | "signal";
  source?: string;
  behind?: boolean;
}

async function fixture(evidence: Evidence[], firstReport = ago(72)) {
  const id = `${prefix}-${++serial}`;
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(${randomUUID()},${id},${firstReport},${at}) RETURNING id`;
  const storyId = Number(story!.id);
  storyIds.push(storyId);
  const sources = new Map<string, string>();
  async function source(key: string, behind = false, kind = "editorial", participant = key) {
    if (sources.has(key)) {
      const existing = sources.get(key)!;
      await sql`UPDATE sources SET participation_mode = ${kind === "editorial" ? "editorial" : "hot_signal"} WHERE id = ${existing}`;
      return existing;
    }
    const sourceId = `${id}-${key}`;
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,signal_group_id,created_at,last_ok_at,next_fetch_at)
      VALUES(${sourceId},${sourceId},'rss','T1',${kind === 'editorial' ? 'editorial' : 'hot_signal'},${id + '-' + participant},${ago(1000)},${behind ? ago(100) : ago(-1)},'2100-01-01')`;
    sources.set(key, sourceId);
    return sourceId;
  }
  async function article(key: string, sourceId: string, observedAt: Date) {
    const articleId = `${id}-${key}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${articleId},${sourceId},${articleId},${`https://example.org/${articleId}`},${articleId},${observedAt},${observedAt})`;
    return articleId;
  }
  for (const [i, e] of evidence.entries()) {
    const sourceId = await source(e.source ?? e.participant, e.behind, e.kind ?? "signal", e.participant);
    const articleId = await article(`e${i}`, sourceId, ago(e.hours));
    if (e.kind === "editorial") {
      const [f] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${articleId},${storyId},${articleId}) RETURNING id`;
      await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${f!.id},${articleId},'report')`;
      await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible)
        VALUES(${articleId},${articleId},${sourceId},'news',${`https://example.org/${articleId}`},${ago(e.hours)},${ago(e.hours)},${ago(e.hours)},true)`;
    }
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
      VALUES(${storyId},${articleId},${e.participant},${sourceId},${e.kind ?? "signal"},${ago(e.hours)})`;
  }
  // 公开代表报道不额外产生热度信号，避免把测试种子混入参与者计数。
  const representativeSource = await source("representative");
  const representative = await article("report", representativeSource, ago(10));
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title)
    VALUES(${id},${storyId},${id}) RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id) VALUES(${fact!.id},${representative})`;
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible)
    VALUES(${representative},${id},${representativeSource},'news',${`https://example.org/${representative}`},${ago(10)},${ago(10)},${ago(10)},true)`;
  return { storyId, sources };
}

async function entry(storyId: number) {
  const result = await computeHotRanking(at);
  rankingIds.push(result.id);
  const [row] = await sql<{ entries: HotEntry[] }[]>`SELECT entries FROM hot_rankings WHERE id=${result.id}`;
  assert.ok(row, "the ranking survives the retention window");
  return row.entries.find((e) => e.storyId === storyId);
}

// 独立按距各窗口终点的小时数计算；百分比沿用展示值的一位小数舍入规则。
function expectedHeat(ages: number[]) {
  return Math.round(ages.reduce((sum, age) => sum + 2 ** (-age / 24), 0) * 100) / 10;
}
function expectedPct(currentAges: number[], previousAges: number[]) {
  const previous = expectedHeat(previousAges);
  return Math.round((expectedHeat(currentAges) - previous) / previous * 1000) / 10;
}
async function snapshot(storyId: number, when = at) {
  const [row] = await sql<{ heat: number; participants: number; cohort: number; complete: boolean }[]>`
    SELECT heat,participants,cohort,complete FROM story_heat_hourly WHERE story_id=${storyId} AND hour=${when}`;
  return row && { ...row, heat: Number(row.heat) };
}

afterEach(async () => {
  if (rankingIds.length) await sql`DELETE FROM hot_rankings WHERE id=ANY(${rankingIds.splice(0)}::bigint[])`;
  if (storyIds.length) {
    await sql`DELETE FROM facts WHERE story_id=ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM stories WHERE id=ANY(${storyIds.splice(0)}::bigint[])`;
  }
  await sql`DELETE FROM articles WHERE source_id LIKE ${prefix + "%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${prefix + "%"}`;
});
after(closeDb);

test("six-hour trend retains the oldest six hours of the previous 48-hour window", async () => {
  const { storyId, sources } = await fixture([
    ...Array.from({ length: 10 }, (_, i) => ({ participant: `old${i}`, hours: 50, kind: "editorial" as const })),
    { participant: "reporter", hours: 10, kind: "editorial" },
    { participant: "fresh", hours: 1 },
  ]);
  const result = (await entry(storyId))!;
  assert.ok(result);
  assert.equal(result.participantCount, 2);
  assert.equal(result.heat, 17.2);
  assert.equal(result.heat, expectedHeat([10, 1]));
  assert.equal(result.trend, "down", "expired participants still belong in the earlier denominator");
  assert.equal(result.trendPct, expectedPct([10, 1], [...Array<number>(10).fill(44), 4]));
  assert.deepEqual(result.badges, []);
  assert.equal(result.sourceCount, 1);
  assert.equal(result.signalCount, 1);
  assert.deepEqual(result.sourceNames, [sources.get("reporter")]);
  assert.deepEqual(result.participants.map((p) => p.name).sort(), [sources.get("reporter"), sources.get("fresh")].sort());
  await snapshotHeat(at);
  assert.deepEqual(await snapshot(storyId), { heat: 17.2, participants: 2, cohort: 1, complete: true });
});

test("both windows exclude their lower endpoint and include their upper endpoint", async () => {
  const { storyId } = await fixture([
    { participant: "before-both", hours: 54 },
    { participant: "just-prior", hours: 54 - 1 / hour },
    { participant: "current-start", hours: 48 },
    { participant: "prior-end", hours: 6, kind: "editorial" },
    { participant: "current-end", hours: 0 },
    { participant: "future", hours: -1 / hour },
  ]);
  const result = (await entry(storyId))!;
  assert.equal(result.participantCount, 2);
  assert.equal(result.heat, expectedHeat([6, 0]));
  assert.equal(result.trendPct, expectedPct([6, 0], [48 - 1 / hour, 42, 0]));
});

test("repeat articles and sources use one independent latest timestamp per window", async () => {
  const { storyId, sources } = await fixture([
    { participant: "shared", source: "expired-a", hours: 51, kind: "editorial" },
    { participant: "shared", source: "expired-b", hours: 50, kind: "editorial" },
    { participant: "shared", source: "current-a", hours: 2 },
    { participant: "shared", source: "current-b", hours: 1 },
    { participant: "reporter", hours: 10, kind: "editorial" },
  ]);
  const result = (await entry(storyId))!;
  assert.equal(result.participantCount, 2);
  assert.equal(result.heat, expectedHeat([1, 10]));
  assert.equal(result.trendPct, expectedPct([1, 10], [44, 4]));
  assert.equal(result.sourceCount, 1, "expired editorial evidence cannot reclassify a current signal");
  assert.equal(result.signalCount, 1);
  assert.deepEqual(result.sourceNames, [sources.get("reporter")]);
  assert.deepEqual(result.participants.map((p) => p.name).sort(), [sources.get("current-b"), sources.get("reporter")].sort());
});

test("previous-only participants do not satisfy current editorial or participant minimums", async () => {
  const noEditorial = await fixture([
    { participant: "expired", hours: 50, kind: "editorial" },
    { participant: "one", hours: 1 }, { participant: "two", hours: 2 },
  ]);
  assert.equal(await entry(noEditorial.storyId), undefined);
  const onlyOne = await fixture([
    { participant: "expired", hours: 50 },
    { participant: "reporter", hours: 1, kind: "editorial" },
  ]);
  assert.equal(await entry(onlyOne.storyId), undefined);
});

test("new trend, old first report, and legitimate surge keep their existing rules", async () => {
  const oldStory = await fixture([
    { participant: "reporter", hours: 2, kind: "editorial" }, { participant: "one", hours: 1 },
  ]);
  const oldResult = (await entry(oldStory.storyId))!;
  assert.equal(oldResult.trend, "new");
  assert.equal(oldResult.trendPct, null);
  assert.deepEqual(oldResult.badges, []);
  const newStory = await fixture([
    { participant: "reporter", hours: 2, kind: "editorial" }, { participant: "one", hours: 1 },
  ], ago(2));
  assert.deepEqual((await entry(newStory.storyId))!.badges, ["new"]);
  const surgeStory = await fixture([
    ...["one", "two", "three"].map((participant) => ({ participant, hours: 50, kind: "editorial" as const })),
    { participant: "one", hours: 1 }, { participant: "two", hours: 2 }, { participant: "three", hours: 3 },
    { participant: "reporter", hours: 10, kind: "editorial" },
  ]);
  const surgeResult = (await entry(surgeStory.storyId))!;
  assert.deepEqual(surgeResult.badges, ["surge"]);
  assert.equal(surgeResult.sourceCount, 1);
  assert.equal(surgeResult.signalCount, 3);
});

test("prior-only behind sources are excluded from comparison without making current snapshots incomplete", async () => {
  const { storyId } = await fixture([
    ...Array.from({ length: 10 }, (_, i) => ({ participant: `old${i}`, hours: 50, behind: true })),
    { participant: "reporter", hours: 10, kind: "editorial" }, { participant: "fresh", hours: 1 },
  ]);
  const result = (await entry(storyId))!;
  assert.equal(result.trend, "up");
  assert.equal(result.trendPct, expectedPct([10, 1], [4]));
  assert.deepEqual(result.badges, ["rising"]);
  await snapshotHeat(at);
  assert.deepEqual(await snapshot(storyId), { heat: expectedHeat([10, 1]), participants: 2, cohort: 1, complete: true });
});

test("a behind source in either window removes its participant from both comparison heats", async () => {
  const { storyId } = await fixture([
    { participant: "prior-only", hours: 50, behind: true },
    { participant: "shared", source: "old-behind", hours: 50, behind: true },
    { participant: "shared", source: "current-caught-up", hours: 1 },
    { participant: "current-only", hours: 2, behind: true },
    { participant: "reporter", hours: 10, kind: "editorial" },
  ]);
  const result = (await entry(storyId))!;
  assert.equal(result.heat, expectedHeat([1, 2, 10]));
  assert.equal(result.participantCount, 3);
  assert.equal(result.trend, "down");
  assert.equal(result.trendPct, expectedPct([10], [4]));
  assert.deepEqual(result.badges, []);
  await snapshotHeat(at);
  assert.equal((await snapshot(storyId))!.complete, false);
});

test("an expired behind source of a current participant affects comparison but not snapshot completeness", async () => {
  const { storyId } = await fixture([
    { participant: "shared", source: "expired", hours: 50, behind: true },
    { participant: "shared", source: "current", hours: 1 },
    { participant: "reporter", hours: 10, kind: "editorial" },
  ]);
  const result = (await entry(storyId))!;
  assert.equal(result.trend, "down");
  assert.equal(result.trendPct, expectedPct([10], [4]));
  await snapshotHeat(at);
  assert.deepEqual(await snapshot(storyId), { heat: expectedHeat([1, 10]), participants: 2, cohort: 1, complete: true });
});

test("an unobserved previous-only baseline is unknown rather than new", async () => {
  const { storyId } = await fixture([
    { participant: "old", hours: 50, behind: true },
    { participant: "reporter", hours: 1, kind: "editorial" }, { participant: "fresh", hours: 2 },
  ]);
  const result = (await entry(storyId))!;
  assert.equal(result.trend, "unknown");
  assert.equal(result.trendPct, null);
  assert.deepEqual(result.badges, []);
});

test("current-only snapshot values survive catch-up repair and explicit backfill", async () => {
  const { storyId, sources } = await fixture([
    { participant: "expired", hours: 50, kind: "editorial", behind: true },
    { participant: "reporter", hours: 10, kind: "editorial", behind: true },
    { participant: "fresh", hours: 1 },
  ]);
  await snapshotHeat(ago(1));
  assert.deepEqual(await snapshot(storyId, ago(1)), { heat: expectedHeat([9, 0]), participants: 2, cohort: 1, complete: false });
  await sql`UPDATE sources SET last_ok_at=${ago(-1)} WHERE id=${sources.get("reporter")!}`;
  const repaired = await snapshotHeat(at);
  assert.equal(repaired.repaired, 1);
  assert.deepEqual(await snapshot(storyId, ago(1)), { heat: expectedHeat([9, 0]), participants: 2, cohort: 1, complete: true });
  assert.deepEqual(await snapshot(storyId), { heat: expectedHeat([10, 1]), participants: 2, cohort: 1, complete: true });
  assert.equal(await backfillStoryHeat(storyId, 1), 2);
  assert.deepEqual(await snapshot(storyId), { heat: expectedHeat([10, 1]), participants: 2, cohort: 1, complete: true });
});

test("a previous-only story gains no current active snapshot or ranking", async () => {
  const { storyId } = await fixture([
    { participant: "expired-a", hours: 50, kind: "editorial" }, { participant: "expired-b", hours: 49 },
  ]);
  assert.equal(await entry(storyId), undefined);
  await snapshotHeat(at);
  assert.equal(await snapshot(storyId), undefined);
  await backfillStoryHeat(storyId, 2);
  assert.equal(await snapshot(storyId), undefined);
});
