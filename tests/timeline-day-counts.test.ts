import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { countTimelineDays, loadTimeline } from "@aihot/backend/publication/timeline";

after(closeDb);
const reference = (grouped: readonly { anchor: number }[], days: ReadonlySet<string>) => {
  const counts: Record<string, number> = {};
  for (const group of grouped) {
    const day = beijingDate(group.anchor);
    if (days.has(day)) counts[day] = (counts[day] ?? 0) + 1;
  }
  return counts;
};
const descending = (anchors: number[]) => anchors.sort((a, b) => b - a).map(anchor => ({ anchor }));

test("day counts retain exact Beijing midnight, leap-day and year boundaries", () => {
  assert.deepEqual(countTimelineDays([], new Set()), {});
  const anchors = ["2023-12-31", "2024-01-01", "2024-02-29", "2024-03-01"].flatMap(day => {
    const midnight = beijingMidnight(day).getTime();
    return [midnight - 1, midnight, midnight, midnight + 1];
  });
  const grouped = descending(anchors);
  const days = new Set(grouped.map(group => beijingDate(group.anchor)));
  assert.deepEqual(countTimelineDays(grouped, days), reference(grouped, days));
  assert.deepEqual(countTimelineDays(grouped, new Set()), {});
  assert.deepEqual(countTimelineDays(grouped, new Set(["1900-01-01"])), {});
});

test("deterministic varied timelines match the full-scan reference", () => {
  let seed = 0x13579bdf;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const base = beijingMidnight("2024-03-01").getTime();
  for (let sample = 0; sample < 300; sample++) {
    const grouped = descending(Array.from({ length: random() % 1200 }, () => base - (random() % 10_000) * 60_000));
    const offset = grouped.length ? random() % grouped.length : 0;
    const days = new Set(grouped.slice(offset, offset + 40).map(group => beijingDate(group.anchor)));
    assert.deepEqual(countTimelineDays(grouped, days), reference(grouped, days), `sample ${sample}`);
  }
});

test("counting a page reads logarithmically many anchors", () => {
  let reads = 0;
  const start = beijingMidnight("2024-03-01").getTime();
  const grouped = Array.from({ length: 300_000 }, (_, index) => ({ get anchor() { reads++; return start - index * 60_000; } }));
  const days = new Set(["2024-02-29", "2024-02-28"]);
  assert.deepEqual(countTimelineDays(grouped, days), { "2024-02-29": 1440, "2024-02-28": 1440 });
  assert.ok(reads <= 4 * Math.ceil(Math.log2(grouped.length + 1)), `expected binary bounds, read ${reads} anchors`);
});

test("real grouped timeline pagination keeps whole-day counts across midnight", async () => {
  const T = tag();
  const source = `day-counts-${T}`;
  const ids: string[] = [];
  const facts: number[] = [];
  const stories: number[] = [];
  const groups: Array<{ anchor: number; key: string }> = [];
  const midnight = beijingMidnight("2024-02-29").getTime();
  const now = new Date("2024-03-02T00:00:00Z");
  try {
    await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${source},'Day counts','rss','T1')`;
    const add = async (index: string, at: number, fact: number | null = null, story: number | null = null) => {
      const id = `${T}-${index}`; ids.push(id);
      const date = new Date(at);
      await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
        VALUES(${id},${source},${id},'https://example.test/days',${id},${date},${date})`;
      await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible,selected,visible_after,visibility,tags,fact_id,story_id)
        VALUES(${id},${id},${source},'news','https://example.test/days',${date},${date},${date},true,true,${date},'public',${[T]},${fact},${story})`;
      if (fact !== null) await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact},${id},'report')`;
      return id;
    };
    for (let index = 0; index < 52; index++) {
      const anchor = midnight + 10_000 - Math.floor(index / 2) * 1000;
      const id = await add(String(index), anchor);
      groups.push({ anchor, key: `a${id}` });
    }
    const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at)
      VALUES(gen_random_uuid(),'Day story',${now},${now}) RETURNING id`;
    stories.push(story!.id);
    for (const storyId of [null, story!.id]) {
      const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title)
        VALUES(${`day-${T}-${facts.length}`},${storyId},'Day fact') RETURNING id`;
      facts.push(fact!.id);
      const anchor = storyId ? midnight : midnight - 86_400_000;
      await add(`group-${facts.length}-a`, anchor - 1, fact!.id, storyId);
      await add(`group-${facts.length}-b`, anchor, fact!.id, storyId);
      groups.push({ anchor, key: storyId ? `s${storyId}` : `f${fact!.id}` });
    }
    groups.sort((a, b) => b.anchor - a.anchor || (a.key < b.key ? 1 : -1));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data = await loadTimeline({ channel: "all", category: null, tag: T, topic: null, now, limit: 7, cursor });
      const pageGroups = groups.slice(seen.length, seen.length + 7);
      assert.deepEqual(data.cards.map(card => card.key), pageGroups.map(group => group.key));
      const days = new Set(pageGroups.map(group => beijingDate(group.anchor)));
      assert.deepEqual(data.dayCounts, reference(groups, days));
      seen.push(...data.cards.map(card => card.key));
      cursor = data.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, groups.map(group => group.key));
    const empty = await loadTimeline({ channel: "all", category: null, tag: `${T}-empty`, topic: null, now });
    assert.deepEqual([empty.cards, empty.dayCounts, empty.nextCursor], [[], {}, null]);
  } finally {
    if (ids.length) await sql`DELETE FROM articles WHERE id IN ${sql(ids)}`;
    if (facts.length) await sql`DELETE FROM facts WHERE id IN ${sql(facts)}`;
    if (stories.length) await sql`DELETE FROM stories WHERE id IN ${sql(stories)}`;
    await sql`DELETE FROM sources WHERE id=${source}`;
  }
});
