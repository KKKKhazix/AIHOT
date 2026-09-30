// Hot ranking: attention over the last 48 hours from independent participants.
// Each participant counts once per window (repeat collection does not add heat), decays with a
// 24-hour half-life, and the source time (not collection time) places evidence in the window.
import { sql } from "../db.ts";
import { tierRank, type HotEntry } from "./hot-read.ts";

export const HOT_RULE_VERSION = "heat-v1-48h-halflife24h";
const WINDOW_HOURS = 48;
const HALF_LIFE_HOURS = 24;
const MIN_PARTICIPANTS = 2;

interface HeatRow {
  story_id: number;
  public_id: string;
  title: string;
  first_report_at: Date | null;
  latest_at: Date | null;
  participants: number;
  heat: number;
  heat_prev: number;
  /** The same two over the participants whose sources were caught up (the comparable group). */
  heat_obs: number;
  heat_prev_obs: number;
  /** Participants with a source whose collection was behind: their newest evidence may be missing. */
  behind_participants: number;
  /** 两个比较窗口中有滞后信源的参与者；不影响仅看当前窗口的快照完整性。 */
  comparison_behind_participants: number;
  recent6h: number;
  editorial_participants: number;
  signal_participants: number;
}

interface SourceClock {
  id: string;
  lastOk: number | null;
  graceMs: number;
}

/** Scheduled sources and their last successful fetch (screenshot-reported and pushed sources cannot visibly fall behind). */
export async function sourceClocks(): Promise<SourceClock[]> {
  const rows = await sql<{ id: string; last_ok_at: Date | null; interval_minutes: number }[]>`
    SELECT id, last_ok_at, interval_minutes FROM sources WHERE enabled AND kind IN ('rss', 'web_list', 'json_list', 'x_search')`;
  return rows.map((r) => ({ id: r.id, lastOk: r.last_ok_at?.getTime() ?? null, graceMs: Math.max(r.interval_minutes * 3, 90) * 60_000 }));
}

/**
 * Sources whose evidence up to `at` may be incomplete. Looking at the present (`grace`), a source is
 * behind after three intervals (at least 90 minutes) without a successful fetch; for an hour already
 * past, it has caught up once any fetch succeeded after that hour (evidence carries the source's time).
 */
export function behindSources(clocks: SourceClock[], at: number, grace: boolean): string[] {
  return clocks.filter((c) => c.lastOk === null || c.lastOk < at - (grace ? c.graceMs : 0)).map((c) => c.id);
}

/** Heat of every story at `at` (defaults to now), from story_signals alone; `behind` marks sources not fully observed. */
async function heatRows(at: Date, behind: string[] = []): Promise<HeatRow[]> {
  const prev = new Date(at.getTime() - 6 * 3600 * 1000);
  const decayNow = sql`power(0.5, extract(epoch FROM (${at}::timestamptz - last_at)) / 3600.0 / ${HALF_LIFE_HOURS})`;
  const decayPrev = sql`power(0.5, extract(epoch FROM (${prev}::timestamptz - last_prev)) / 3600.0 / ${HALF_LIFE_HOURS})`;
  const inCurrentWindow = sql`observed_at > ${at}::timestamptz - make_interval(hours => ${WINDOW_HOURS})`;
  const inPrevWindow = sql`last_prev IS NOT NULL AND last_prev > ${prev}::timestamptz - make_interval(hours => ${WINDOW_HOURS})`;
  return sql<HeatRow[]>`
    WITH obs AS (
      SELECT story_id, participant_key,
             max(observed_at) FILTER (WHERE ${inCurrentWindow}) AS last_at,
             min(observed_at) FILTER (WHERE ${inCurrentWindow}) AS first_at,
             bool_or(kind = 'editorial') FILTER (WHERE ${inCurrentWindow}) AS editorial,
             max(observed_at) FILTER (WHERE observed_at <= ${prev}) AS last_prev,
             bool_or(source_id = ANY(${behind}::text[])) FILTER (WHERE ${inCurrentWindow}) AS behind_current,
             bool_or(source_id = ANY(${behind}::text[])) AS behind
      FROM story_signals
      WHERE observed_at > ${prev}::timestamptz - make_interval(hours => ${WINDOW_HOURS}) AND observed_at <= ${at}
      GROUP BY story_id, participant_key
    ), agg AS (
      SELECT story_id,
        count(last_at) AS participants,
        sum(${decayNow}) AS heat,
        coalesce(sum(${decayPrev}) FILTER (WHERE ${inPrevWindow}), 0) AS heat_prev,
        coalesce(sum(${decayNow}) FILTER (WHERE NOT behind), 0) AS heat_obs,
        coalesce(sum(${decayPrev}) FILTER (WHERE ${inPrevWindow} AND NOT behind), 0) AS heat_prev_obs,
        count(*) FILTER (WHERE behind_current) AS behind_participants,
        count(*) FILTER (WHERE behind) AS comparison_behind_participants,
        count(*) FILTER (WHERE first_at > ${prev}) AS recent6h,
        count(*) FILTER (WHERE editorial) AS editorial_participants,
        count(*) FILTER (WHERE NOT editorial) AS signal_participants
      FROM obs GROUP BY story_id HAVING count(last_at) > 0
    )
    SELECT a.story_id, st.public_id::text AS public_id, st.title, st.first_report_at, st.latest_at,
           a.participants, a.heat, a.heat_prev, a.heat_obs, a.heat_prev_obs, a.behind_participants, a.comparison_behind_participants, a.recent6h, a.editorial_participants, a.signal_participants
    FROM agg a JOIN stories st ON st.id = a.story_id
    WHERE st.merged_into IS NULL`;
}

export function heatIndex(heat: number): number {
  return Math.round(heat * 100) / 10; // one decimal on the 10× scale shown to readers
}

export async function computeHotRanking(at = new Date()): Promise<{ id: number; entries: number }> {
  const behind = behindSources(await sourceClocks(), at.getTime(), true);
  const rows = (await heatRows(at, behind)).filter((r) => Number(r.participants) >= MIN_PARTICIPANTS && Number(r.editorial_participants) >= 1);
  rows.sort((a, b) => Number(b.heat) - Number(a.heat) || (b.latest_at?.getTime() ?? 0) - (a.latest_at?.getTime() ?? 0));

  const entries: HotEntry[] = [];
  for (const r of rows) {
    if (entries.length >= 10) break;
    const reports = await sql<{ id: string; url: string; title: string; source_name: string; first_party: boolean; selected: boolean; score: number | null; at: Date }[]>`
      SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.url, p.title, s.name AS source_name, p.first_party, p.selected, p.score,
             coalesce(p.published_at, p.discovered_at) AS at
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      JOIN sources s ON s.id = p.source_id
      WHERE f.story_id = ${r.story_id} AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${at})
      ORDER BY p.article_id`;
    if (reports.length === 0) continue;
    const rep = [...reports].sort((x, y) => Number(y.first_party) - Number(x.first_party) || Number(y.selected) - Number(x.selected) || (Number(y.score ?? 0) - Number(x.score ?? 0)))[0]!;
    const participants = await sql<{ name: string; kind: "editorial" | "signal"; tier: string; at: Date }[]>`
      SELECT DISTINCT ON (ss.participant_key) s.name, ss.kind, s.tier, ss.observed_at AS at
      FROM story_signals ss JOIN sources s ON s.id = ss.source_id
      WHERE ss.story_id = ${r.story_id} AND ss.observed_at > ${at}::timestamptz - make_interval(hours => ${WINDOW_HOURS}) AND ss.observed_at <= ${at}
      ORDER BY ss.participant_key, (ss.kind = 'editorial') DESC, ss.observed_at DESC`;
    // The reporting sources of the window, latest first (signal participants are counted separately).
    const reporting = participants.filter((p) => p.kind === "editorial").sort((x, y) => y.at.getTime() - x.at.getTime());
    const heat = heatIndex(Number(r.heat));
    // The change against six hours before compares only participants whose sources were observed
    // throughout; with none of the earlier ones observed there is no comparison.
    const prevAll = heatIndex(Number(r.heat_prev));
    const [cur, prev] = Number(r.comparison_behind_participants) > 0 ? [heatIndex(Number(r.heat_obs)), heatIndex(Number(r.heat_prev_obs))] : [heat, prevAll];
    const pct = prev > 0 ? (cur - prev) / prev : null;
    const firstAt = r.first_report_at ?? reports[0]!.at;
    const isNew = at.getTime() - firstAt.getTime() < 6 * 3600 * 1000;
    const surge = Number(r.recent6h) >= 3 && Number(r.recent6h) / Number(r.participants) >= 0.5;
    const badges: HotEntry["badges"] = [];
    if (surge) badges.push("surge");
    if (isNew) badges.push("new");
    if (!surge && pct !== null && pct > 0.15) badges.push("rising");
    const sourceNames = [...new Set(reporting.map((x) => x.name))].slice(0, 8);
    entries.push({
      rank: entries.length + 1,
      storyId: r.story_id,
      storyPublicId: r.public_id,
      title: r.title,
      heat,
      trend: prevAll <= 0 ? "new" : pct === null ? "unknown" : pct > 0.1 ? "up" : pct < -0.1 ? "down" : "flat",
      trendPct: pct === null ? null : Math.round(pct * 1000) / 10,
      badges,
      participantCount: Number(r.participants),
      sourceCount: Number(r.editorial_participants),
      signalCount: Number(r.signal_participants),
      reportCount: reports.length,
      sourceNames,
      latestAt: (r.latest_at ?? at).toISOString(),
      firstReportAt: firstAt.toISOString(),
      representativeItemId: rep.id,
      representativeUrl: rep.url,
      representativeSource: rep.source_name,
      // Faces go to the 精选组 by tier, the most recently active first within a tier (ordered before the cap).
      participants: participants
        .sort((x, y) => Number(y.kind === "editorial") - Number(x.kind === "editorial") || tierRank(x.tier) - tierRank(y.tier) || y.at.getTime() - x.at.getTime())
        .slice(0, 40).map(({ name, kind, tier }) => ({ name, kind, tier })),
    });
  }
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO hot_rankings (computed_at, rule_version, entries, evidence, published)
    VALUES (${at}, ${HOT_RULE_VERSION}, ${sql.json(entries as never)},
            ${sql.json({ windowHours: WINDOW_HOURS, halfLifeHours: HALF_LIFE_HOURS, minParticipants: MIN_PARTICIPANTS, candidates: rows.length } as never)}, true)
    RETURNING id`;
  // Keep a bounded history of rankings.
  await sql`DELETE FROM hot_rankings WHERE computed_at < now() - interval '30 days'`;
  return { id: row!.id, entries: entries.length };
}

/**
 * Hourly heat snapshot for active stories (event page trend). An hour taken while a participant's
 * source was behind is marked incomplete (the charts leave it out) and recomputed once the sources
 * have fetched past it: values are deterministic from the signals, which carry the source's time.
 */
export async function snapshotHeat(at = new Date()): Promise<{ stories: number; repaired: number }> {
  const hour = new Date(Math.floor(at.getTime() / 3600000) * 3600000);
  const clocks = await sourceClocks();
  const rows = await heatRows(hour, behindSources(clocks, hour.getTime(), true));
  for (const r of rows) {
    await sql`
      INSERT INTO story_heat_hourly (story_id, hour, heat, participants, cohort, complete)
      VALUES (${r.story_id}, ${hour}, ${heatIndex(Number(r.heat))}, ${Number(r.participants)}, ${Number(r.editorial_participants)}, ${Number(r.behind_participants) === 0})
      ON CONFLICT (story_id, hour) DO UPDATE SET heat = EXCLUDED.heat, participants = EXCLUDED.participants, cohort = EXCLUDED.cohort, complete = EXCLUDED.complete`;
  }
  let repaired = 0;
  const stale = await sql<{ hour: Date; stories: number[] }[]>`
    SELECT hour, array_agg(story_id) AS stories FROM story_heat_hourly
    WHERE NOT complete AND hour < ${hour} AND hour > ${new Date(hour.getTime() - WINDOW_HOURS * 3600000)} GROUP BY hour ORDER BY hour`;
  for (const s of stale) {
    const wanted = new Set(s.stories.map(Number));
    for (const r of await heatRows(s.hour, behindSources(clocks, s.hour.getTime(), false))) {
      if (!wanted.has(Number(r.story_id)) || Number(r.behind_participants) > 0) continue;
      await sql`UPDATE story_heat_hourly SET heat = ${heatIndex(Number(r.heat))}, participants = ${Number(r.participants)}, cohort = ${Number(r.editorial_participants)}, complete = true
                WHERE story_id = ${r.story_id} AND hour = ${s.hour}`;
      repaired += 1;
    }
  }
  return { stories: rows.length, repaired };
}

/** Recomputes hourly snapshots for a story over its history (after imports or regrouping). */
export async function backfillStoryHeat(storyId: number, hours = 7 * 24): Promise<number> {
  const [s] = await sql<{ first: Date | null; last: Date | null }[]>`SELECT min(observed_at) AS first, max(observed_at) AS last FROM story_signals WHERE story_id = ${storyId}`;
  if (!s?.first) return 0;
  const end = Math.floor(Math.min(Date.now(), (s.last?.getTime() ?? Date.now()) + WINDOW_HOURS * 3600000) / 3600000) * 3600000;
  const start = Math.max(Math.floor(s.first.getTime() / 3600000) * 3600000, end - hours * 3600000);
  const clocks = await sourceClocks();
  let n = 0;
  for (let t = start; t <= end; t += 3600000) {
    const rows = (await heatRows(new Date(t), behindSources(clocks, t, false))).filter((r) => Number(r.story_id) === storyId);
    for (const r of rows) {
      await sql`INSERT INTO story_heat_hourly (story_id, hour, heat, participants, cohort, complete)
                VALUES (${storyId}, ${new Date(t)}, ${heatIndex(Number(r.heat))}, ${Number(r.participants)}, ${Number(r.editorial_participants)}, ${Number(r.behind_participants) === 0})
                ON CONFLICT (story_id, hour) DO UPDATE SET heat = EXCLUDED.heat, participants = EXCLUDED.participants, complete = EXCLUDED.complete`;
      n += 1;
    }
  }
  return n;
}
