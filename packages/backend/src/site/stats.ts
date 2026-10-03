// Figures for the about page: how much the site covers, counted from the public read layer and kept for
// ten minutes per process (the page itself is cached for five); an older copy is served while the
// counts are read again, so no reader waits for the full-table counts.
import type { SiteStats } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { publicSourceName } from "../publication/rules.ts";
import { selectedCondition } from "../publication/scope.ts";

export type { SiteStats };

/** How many sources the about page's river draws, at most. */
const SAMPLE = 180;

const stats = cached(() => querySiteStats(new Date()), { freshMs: 10 * 60_000, maxStaleMs: 60 * 60_000 });

export function loadSiteStats(): Promise<SiteStats> {
  return stats.get();
}

async function querySiteStats(now: Date): Promise<SiteStats> {
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const [[row], kinds, sample, latest] = await Promise.all([
    sql<Array<Omit<SiteStats, "sourceKinds" | "day" | "sampleSources" | "latest"> & { collected: number; selectedDay: number }>>`
      SELECT (SELECT count(*) FROM sources WHERE enabled)::int AS sources,
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn')::int AS items,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now)})::int AS selected,
             (SELECT count(*) FROM reports WHERE kind = 'daily')::int AS dailies,
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn' AND p.discovered_at > ${dayAgo})::int AS collected,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now)} AND p.timeline_at > ${dayAgo})::int AS "selectedDay"`,
    sql<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM sources WHERE enabled GROUP BY kind`,
    // A shuffle that holds for the day, so the river keeps its sources between visits.
    sql<{ name: string; kind: string; heat_only: boolean }[]>`
      SELECT name, kind, participation_mode = 'hot_signal' AS heat_only FROM sources WHERE enabled
      ORDER BY md5(id::text || ${now.toISOString().slice(0, 10)}) LIMIT ${SAMPLE}`,
    sql<{ id: string; title: string; source: string }[]>`
      SELECT p.article_id AS id, p.title, s.name AS source FROM publications p JOIN sources s ON s.id = p.source_id
      WHERE ${selectedCondition(now)} ORDER BY p.timeline_at DESC LIMIT 8`,
  ]);
  const { collected, selectedDay, ...totals } = row!;
  const value: SiteStats = {
    ...totals,
    sourceKinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
    day: { collected, selected: selectedDay },
    sampleSources: sample.map((s) => ({ name: publicSourceName(s.name), kind: s.kind, heatOnly: s.heat_only })),
    latest: latest.map((item) => ({ ...item, source: publicSourceName(item.source) })),
  };
  return value;
}
