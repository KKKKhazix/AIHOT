import { selectedCondition, pendingReleaseCondition, listedCondition } from "./scope.ts";
// Home timeline: selected items folded into reading groups (reference SELECTED_READING):
// one card per story, per fact outside a story, or per standalone article. A card sits at its latest
// development's first appearance, so a new development brings it back up while a representative swap
// never moves it; the representative is the first-party pick of the story's initiating fact.
import type { GroupInfo, TimelineCard, TimelineFilters, TimelineResponse } from "@aihot/contracts/site";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, tagCondition, toFeedItemSummary, topicCondition,
  type ItemRow,
} from "./items.ts";

export interface TimelineQuery extends TimelineFilters {
  cursor?: string | null;
  limit?: number;
  topicTags?: string[] | null;
  now?: Date;
}

interface GroupRow {
  gk: string;
  anchor_at: Date;
}

function filterSql(q: TimelineQuery) {
  return sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)} ${topicCondition(q.topicTags)}`;
}

function binding(q: TimelineQuery): string {
  return queryBinding({ c: q.channel, k: q.category, t: q.tag, p: q.topic ?? null });
}

/** Representative preference: first-party, full text, higher score, earliest. */
type RepresentativeRow = Pick<ItemRow, "first_party" | "body_mode" | "score" | "timeline_at">;
export function pickRepresentative<T extends RepresentativeRow>(rows: T[]): T {
  return [...rows].sort((a, b) => {
    if (a.first_party !== b.first_party) return a.first_party ? -1 : 1;
    if (a.body_mode !== b.body_mode) return a.body_mode === "full" ? -1 : 1;
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sa !== sb) return sb - sa;
    return a.timeline_at.getTime() - b.timeline_at.getTime();
  })[0]!;
}

/**
 * Public pool reports linked to the facts of the given stories and standalone facts, under the same
 * filters (non-selected included): the sets "另有 N 家信源报道" expands and the group counts come from.
 */
async function groupPool(q: TimelineQuery, now: Date, storyIds: number[], factIds: number[]) {
  if (!storyIds.length && !factIds.length) return [];
  return sql<{ story_id: number | null; fact_id: number; article_id: string; source_id: string; at: Date }[]>`
    SELECT DISTINCT f.story_id, f.id AS fact_id, p.article_id, p.source_id, p.timeline_at AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    WHERE (f.story_id IN ${sql(storyIds.length ? storyIds : [0])} OR f.id IN ${sql(factIds.length ? factIds : [0])})
      AND ${listedCondition(now)} ${filterSql(q)}`;
}

/**
 * The selected set grouped into cards, newest first. Keep anchors and their release deadline
 * together: returning old anchors with a newer deadline could cache a missing card for a minute.
 */
interface GroupedSnapshot {
  rows: Array<{ gk: string; anchor: number }>;
  refreshAt: string | null;
}
const groupedCache = new Map<string, { at: number; data: GroupedSnapshot }>();
const groupedPending = new Map<string, Promise<GroupedSnapshot>>();
async function groupedAnchors(q: TimelineQuery, now: Date): Promise<GroupedSnapshot> {
  const key = binding(q);
  const expired = (data: GroupedSnapshot) => data.refreshAt !== null && now.getTime() >= Date.parse(data.refreshAt);
  const cached = q.now ? undefined : groupedCache.get(key);
  if (cached && Date.now() - cached.at < 5000 && !expired(cached.data)) return cached.data;
  const pending = q.now ? undefined : groupedPending.get(key);
  if (pending) {
    const data = await pending;
    // A reader after the release must not inherit a still-running pre-release snapshot.
    return expired(data) ? groupedAnchors(q, now) : data;
  }
  const load = Promise.all([queryGroupedAnchors(q, now), nextRelease(q, now)])
    .then(([rows, refreshAt]) => ({ rows, refreshAt }));
  if (q.now) return load;
  const work = load.then((data) => {
    if (groupedCache.size >= 50) groupedCache.delete(groupedCache.keys().next().value!);
    groupedCache.set(key, { at: Date.now(), data });
    return data;
  }).finally(() => { groupedPending.delete(key); });
  groupedPending.set(key, work);
  return work;
}

async function queryGroupedAnchors(q: TimelineQuery, now: Date) {
  const rows = (
    await sql<{ gk: string; anchor_at: Date }[]>`
      WITH base AS (
        SELECT p.sort_at, coalesce('s' || p.story_id::text, 'f' || p.fact_id::text, 'a' || p.article_id) AS gk
        FROM publications p
        WHERE ${selectedCondition(now)} ${filterSql(q)}
      )
      SELECT gk, max(sort_at) AS anchor_at FROM base GROUP BY gk ORDER BY anchor_at DESC, gk COLLATE "C" DESC`
  ).map((r) => ({ gk: r.gk, anchor: r.anchor_at.getTime() }));
  return rows;
}

/** Counts requested Beijing days over anchors already sorted newest first. */
export function countTimelineDays(grouped: readonly { anchor: number }[], days: ReadonlySet<string>): Record<string, number> {
  const firstBelow = (bound: number) => {
    let lo = 0, hi = grouped.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (grouped[mid]!.anchor >= bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const counts: Record<string, number> = {};
  for (const day of days) {
    const start = beijingMidnight(day).getTime();
    const count = firstBelow(start) - firstBelow(start + 86_400_000);
    if (count) counts[day] = count;
  }
  return counts;
}

export async function loadTimeline(q: TimelineQuery): Promise<Omit<TimelineResponse, "hot" | "generatedAt">> {
  const now = q.now ?? new Date();
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
  const bind = binding(q);
  let after: { a: number; g: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<{ a: number; g: string; b: string }>("tl1", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.g !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { a: c.a, g: c.g };
  }

  const { rows: grouped, refreshAt } = await groupedAnchors(q, now);
  const start = after ? grouped.findIndex((g) => g.anchor < after!.a || (g.anchor === after!.a && g.gk < after!.g)) : 0;
  const groups: GroupRow[] = (start < 0 ? [] : grouped.slice(start, start + limit + 1)).map((g) => ({ gk: g.gk, anchor_at: new Date(g.anchor) }));

  const page = groups.slice(0, limit);
  const hasMore = groups.length > limit;

  const storyIds = page.filter((g) => g.gk.startsWith("s")).map((g) => Number(g.gk.slice(1)));
  const factIds = page.filter((g) => g.gk.startsWith("f")).map((g) => Number(g.gk.slice(1)));

  // Read only ranking fields for the whole group; bodies, media and translations are hydrated for this page's representatives.
  type Member = RepresentativeRow & Pick<ItemRow, "id" | "sort_at"> & { story_id: number | null; fact_id: number };
  const [members, pool] = await Promise.all([
    storyIds.length || factIds.length
      ? sql<Member[]>`
        SELECT p.story_id, p.fact_id, p.article_id AS id, p.first_party, p.body_mode, p.score, p.timeline_at, p.sort_at FROM publications p
        WHERE (p.story_id IN ${sql(storyIds.length ? storyIds : [0])} OR (p.story_id IS NULL AND p.fact_id IN ${sql(factIds.length ? factIds : [0])}))
          AND ${selectedCondition(now)} ${filterSql(q)}`
      : Promise.resolve([] as Member[]),
    groupPool(q, now, storyIds, factIds),
  ]);
  const groupFactIds = [...new Set([...members.map((m) => m.fact_id), ...pool.map((r) => r.fact_id)])];
  const factInfo = new Map(
    groupFactIds.length ? (await sql<{ id: number; public_id: string; title: string }[]>`SELECT id, public_id, title FROM facts WHERE id IN ${sql(groupFactIds)}`).map((f) => [f.id, f]) : [],
  );
  const firstSeen = (list: Member[]) => Math.min(...list.map((r) => (r.sort_at ?? r.timeline_at).getTime()));

  const planned: Array<{ key: string; anchorAt: string; id: string; group: GroupInfo | null }> = [];
  for (const g of page) {
    if (g.gk.startsWith("a")) {
      planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: g.gk.slice(1), group: null });
      continue;
    }
    const id = Number(g.gk.slice(1));
    const isStory = g.gk.startsWith("s");
    const byFact = new Map<number, Member[]>();
    for (const m of members) {
      if (isStory ? m.story_id !== id : m.story_id !== null || m.fact_id !== id) continue;
      byFact.set(m.fact_id, [...(byFact.get(m.fact_id) ?? []), m]);
    }
    if (byFact.size === 0) continue;
    const reports = pool.filter((r) => (isStory ? r.story_id === id : r.fact_id === id));
    // The group stands for its initiating fact, the one first reported; that fact's first-party pick
    // represents it, or, when it has no selected report, the pick of the earliest fact that has one.
    const firstReport = new Map<number, number>();
    for (const r of reports) firstReport.set(r.fact_id, Math.min(firstReport.get(r.fact_id) ?? Infinity, r.at.getTime()));
    const mainFact = [...firstReport.entries()].sort((x, y) => x[1] - y[1] || x[0] - y[0])[0]?.[0] ?? [...byFact.keys()][0]!;
    const repRows = byFact.get(mainFact) ?? [...byFact.values()].sort((x, y) => firstSeen(x) - firstSeen(y))[0]!;
    const rep = pickRepresentative(repRows);
    const mainReports = reports.filter((r) => r.fact_id === mainFact);
    const [newestFact, newestRows] = [...byFact.entries()].sort((x, y) => firstSeen(y[1]) - firstSeen(x[1]) || y[0] - x[0])[0]!;
    const newest = newestFact !== mainFact ? factInfo.get(newestFact) : undefined;
    const group: GroupInfo = {
      factId: factInfo.get(mainFact)?.public_id ?? String(mainFact),
      story: null,
      additionalSourceCount: Math.max(0, new Set(mainReports.map((r) => r.source_id)).size - 1),
      // Reports of the facts that have a selected report (the developments), counted once each.
      reportCount: new Set(reports.filter((r) => byFact.has(r.fact_id)).map((r) => r.article_id)).size,
      developmentCount: byFact.size,
      latestDevelopment: newest ? { factId: newest.public_id, title: newest.title, at: new Date(firstSeen(newestRows)).toISOString() } : null,
    };
    const showGroup = group.reportCount > 1 || group.developmentCount > 1;
    planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: rep.id, group: showGroup ? group : null });
  }

  // Recheck scope when hydrating: a withdrawal may commit after the narrow representative read.
  const rows = new Map(planned.length ? (await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${sql(planned.map((p) => p.id))}
      AND ${selectedCondition(now)} ${filterSql(q)}`).map((row) => [row.id, row]) : []);
  const cards: TimelineCard[] = planned.flatMap(({ id, key, anchorAt, group }) => {
    const row = rows.get(id);
    if (!row) return [];
    if (group) group.story = row.story_public_id ? { publicId: row.story_public_id, title: row.story_title ?? "" } : null;
    return [{ key, anchorAt, item: toFeedItemSummary(row), group }];
  });

  // Day header counts for the days on this page, over the full grouped set.
  const days = new Set(page.map((g) => beijingDate(g.anchor_at)));
  const dayCounts = countTimelineDays(grouped, days);

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("tl1", { a: last.anchor_at.getTime(), g: last.gk, b: bind }) : null;
  return { filters: { channel: q.channel, category: q.category, tag: q.tag, topic: q.topic ?? null }, cards, nextCursor, refreshAt, dayCounts };
}

/** Earliest pending release in this scope; caches of this scope must expire by then. */
export async function nextRelease(q: TimelineQuery, now: Date): Promise<string | null> {
  const [row] = await sql<{ t: Date | null }[]>`
    SELECT min(p.visible_after) AS t FROM publications p
    WHERE ${pendingReleaseCondition(now)} ${filterSql(q)}`;
  return row?.t ? row.t.toISOString() : null;
}
