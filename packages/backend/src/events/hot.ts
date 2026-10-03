// Hot ranking: attention over the last 48 hours from independent participants.
// Each participant counts once per window (repeat collection does not add heat), decays with a
// 24-hour half-life, and the source time (not collection time) places evidence in the window.
import { sql, type Db } from "../db.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeIdentity } from "../publication/representative.ts";
import { evidenceCondition, listedCondition } from "../publication/scope.ts";

/** One entry of a stored ranking; the public read layer (publication/hot.ts) re-checks it before showing it. */
export interface HotEntry {
  rank: number;
  storyId: number;
  storyPublicId: string;
  title: string;
  heat: number;
  /** "unknown": the earlier participants' sources were behind on collection, so there is no comparison. */
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising">;
  participantCount: number;
  sourceCount: number;
  signalCount: number;
  reportCount: number;
  sourceNames: string[];
  latestAt: string;
  firstReportAt: string;
  representativeItemId: string | null;
  representativeUrl: string | null;
  representativeSource: string | null;
  /** 精选组 first by tier, then 氛围组; tier is absent on rankings stored by older versions. */
  participants: Array<{ name: string; kind: "editorial" | "signal"; tier?: string }>;
}

/** Participants in the 精选组 order: T1 before T1.5 before T2, then everything else. */
const TIER_ORDER = ["T1", "T1_5", "T2"];
export function tierRank(tier: string | undefined): number {
  const i = TIER_ORDER.indexOf(tier ?? "");
  return i < 0 ? TIER_ORDER.length : i;
}

export interface HotRanking {
  id: number;
  computedAt: string;
  ruleVersion: string;
  entries: HotEntry[];
  coverage: Record<string, unknown> | null;
}

/** Administrative invalidation needs the saved references, including ones already hidden publicly. */
export async function storedHotRanking(db: Db = sql): Promise<HotRanking | null> {
  const [row] = await db<{ id: number; computed_at: Date; rule_version: string; entries: HotEntry[]; evidence: Record<string, unknown> | null }[]>`
    SELECT id, computed_at, rule_version, entries, evidence FROM hot_rankings WHERE published ORDER BY computed_at DESC LIMIT 1`;
  if (!row) return null;
  return { id: row.id, computedAt: row.computed_at.toISOString(), ruleVersion: row.rule_version, entries: row.entries, coverage: row.evidence };
}

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
  /** Participants left out of the comparison (behind, or a source added after the earlier window began). */
  uncomparable: number;
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

/**
 * The heat evidence as it stands now, for every reader of story_signals: a report withdrawn since no
 * longer counts, a source counts in its current role (editorial or signal) and an isolated one not at
 * all, and a participant is the independent actor behind a post: an operator's media matrix (signal
 * group), a company's own channels (owner), else the source itself. Admin changes to roles, groups and
 * owners therefore reach the heat at once, without rewriting stored signals.
 */
export const currentSignals = () => sql`(
  SELECT ss.story_id, ss.article_id, s.id AS source_id, ss.observed_at, s.created_at AS source_since,
    CASE WHEN s.participation_mode = 'editorial' THEN 'editorial' ELSE 'signal' END AS kind,
    CASE
      WHEN s.signal_group_id IS NOT NULL THEN 'group:' || s.signal_group_id
      WHEN s.owner_entity_id IS NOT NULL THEN 'owner:' || s.owner_entity_id
      ELSE 'source:' || s.id
    END AS participant_key
  FROM story_signals ss JOIN articles a ON a.id = ss.article_id JOIN sources s ON s.id = a.source_id
  LEFT JOIN publications p ON p.article_id = ss.article_id
  WHERE s.participation_mode <> 'isolated' AND coalesce(p.visibility, 'public') <> 'withdrawn'
    AND NOT EXISTS (SELECT 1 FROM grouping_overrides go WHERE go.article_id = ss.article_id AND go.mode = 'standalone')
    AND (s.participation_mode <> 'editorial' OR EXISTS (SELECT 1 FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
      WHERE fa.article_id = ss.article_id AND f.story_id = ss.story_id AND ${evidenceCondition()}))
)`;

/**
 * Heat of every story at `at` (defaults to now) from the current evidence; `behind` marks sources not
 * fully observed. The change compares with six hours before over that time's own 48-hour window, and
 * only over participants observed throughout both: none of their sources behind, and every source
 * already collecting when the earlier window began (a source added since widens what is seen; it
 * adds to the heat, not to its growth).
 */
export async function heatRows(at: Date, behind: string[] = [], storyIds?: number[]): Promise<HeatRow[]> {
  const prev = new Date(at.getTime() - 6 * 3600 * 1000);
  const nowFrom = sql`${at}::timestamptz - make_interval(hours => ${WINDOW_HOURS})`;
  const prevFrom = sql`${prev}::timestamptz - make_interval(hours => ${WINDOW_HOURS})`;
  const decayNow = sql`power(0.5, extract(epoch FROM (${at}::timestamptz - last_at)) / 3600.0 / ${HALF_LIFE_HOURS})`;
  const decayPrev = sql`power(0.5, extract(epoch FROM (${prev}::timestamptz - last_prev)) / 3600.0 / ${HALF_LIFE_HOURS})`;
  const comparable = sql`(NOT behind AND NOT late)`;
  return sql<HeatRow[]>`
    WITH obs AS (
      SELECT story_id, participant_key,
             max(observed_at) FILTER (WHERE observed_at > ${nowFrom}) AS last_at,
             min(observed_at) FILTER (WHERE observed_at > ${nowFrom}) AS first_at,
             coalesce(bool_or(kind = 'editorial') FILTER (WHERE observed_at > ${nowFrom}), false) AS editorial,
             max(observed_at) FILTER (WHERE observed_at <= ${prev}) AS last_prev,
             bool_or(source_id = ANY(${behind}::text[])) AS behind,
             bool_or(source_since > ${prevFrom}) AS late
      FROM ${currentSignals()} cs
      WHERE observed_at > ${prevFrom} AND observed_at <= ${at}
        ${storyIds ? sql`AND story_id = ANY(${storyIds}::bigint[])` : sql``}
      GROUP BY story_id, participant_key
    ), agg AS (
      SELECT story_id,
        count(*) FILTER (WHERE last_at IS NOT NULL) AS participants,
        coalesce(sum(${decayNow}) FILTER (WHERE last_at IS NOT NULL), 0) AS heat,
        coalesce(sum(${decayPrev}) FILTER (WHERE last_prev IS NOT NULL), 0) AS heat_prev,
        coalesce(sum(${decayNow}) FILTER (WHERE last_at IS NOT NULL AND ${comparable}), 0) AS heat_obs,
        coalesce(sum(${decayPrev}) FILTER (WHERE last_prev IS NOT NULL AND ${comparable}), 0) AS heat_prev_obs,
        count(*) FILTER (WHERE last_at IS NOT NULL AND behind) AS behind_participants,
        count(*) FILTER (WHERE (last_at IS NOT NULL OR last_prev IS NOT NULL) AND NOT ${comparable}) AS uncomparable,
        count(*) FILTER (WHERE first_at > ${prev}) AS recent6h,
        count(*) FILTER (WHERE last_at IS NOT NULL AND editorial) AS editorial_participants,
        count(*) FILTER (WHERE last_at IS NOT NULL AND NOT editorial) AS signal_participants
      FROM obs GROUP BY story_id
      HAVING count(*) FILTER (WHERE last_at IS NOT NULL) > 0
    )
    SELECT a.story_id, st.public_id::text AS public_id, st.title, st.first_report_at, st.latest_at,
           a.participants, a.heat, a.heat_prev, a.heat_obs, a.heat_prev_obs, a.behind_participants, a.uncomparable, a.recent6h, a.editorial_participants, a.signal_participants
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
    const reports = await sql<Array<RepresentativeIdentity & { id: string; url: string; title: string; source_id: string; source_name: string; selected: boolean; score: number | null; at: Date; timeline_at: Date; body_mode: "full" | "summary"; fact_id: number }>>`
      SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.url, p.title, s.id AS source_id, s.name AS source_name, p.selected, p.score, p.timeline_at, p.body_mode,
             f.id AS fact_id, ${REPRESENTATIVE_COLUMNS}, coalesce(p.published_at, p.discovered_at) AS at
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      JOIN sources s ON s.id = p.source_id
      WHERE f.story_id = ${r.story_id} AND ${evidenceCondition()} AND ${listedCondition(at)}
      ORDER BY p.article_id, (fa.role = 'primary') DESC, f.id`;
    if (reports.length === 0) continue;
    // The event is shown under its own title, linked to the fact most sources report: the launch,
    // not the leak or teaser that came first. Between equally reported facts the earlier one stands,
    // so a single high-scoring follow-up cannot take the link.
    type Report = (typeof reports)[number];
    const byFact = new Map<number, Report[]>();
    for (const report of reports) byFact.set(report.fact_id, [...(byFact.get(report.fact_id) ?? []), report]);
    const sourceCount = (list: Report[]) => new Set(list.map((report) => report.source_id)).size;
    const firstSeen = (list: Report[]) => Math.min(...list.map((report) => report.timeline_at.getTime()));
    const members = [...byFact.values()].sort((a, b) => sourceCount(b) - sourceCount(a) || firstSeen(a) - firstSeen(b) || a[0]!.fact_id - b[0]!.fact_id)[0]!;
    const selected = members.filter((report) => report.selected);
    const rep = pickRepresentative(selected.length ? selected : members);
    const participants = await sql<{ name: string; kind: "editorial" | "signal"; tier: string; at: Date }[]>`
      SELECT DISTINCT ON (cs.participant_key) s.name, cs.kind, s.tier, cs.observed_at AS at
      FROM ${currentSignals()} cs JOIN sources s ON s.id = cs.source_id
      WHERE cs.story_id = ${r.story_id} AND cs.observed_at > ${at}::timestamptz - make_interval(hours => ${WINDOW_HOURS}) AND cs.observed_at <= ${at}
      ORDER BY cs.participant_key, (cs.kind = 'editorial') DESC, cs.observed_at DESC`;
    // The reporting sources of the window, latest first (signal participants are counted separately).
    const reporting = participants.filter((p) => p.kind === "editorial").sort((x, y) => y.at.getTime() - x.at.getTime());
    const heat = heatIndex(Number(r.heat));
    // The change against six hours before compares only participants whose sources were observed
    // throughout; with none of the earlier ones observed there is no comparison.
    const prevAll = heatIndex(Number(r.heat_prev));
    const [cur, prev] = Number(r.uncomparable) > 0 ? [heatIndex(Number(r.heat_obs)), heatIndex(Number(r.heat_prev_obs))] : [heat, prevAll];
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
 * One bounded batch per hour, shared by live snapshots and historical repair. All derived fields
 * are replaced together, including the cohort when a source's participation changes.
 */
async function saveHeat(rows: HeatRow[], hour: Date): Promise<number> {
  for (let i = 0; i < rows.length; i += 1000) {
    const values = rows.slice(i, i + 1000).map((r) => ({
      story_id: r.story_id, hour, heat: heatIndex(Number(r.heat)), participants: Number(r.participants),
      cohort: Number(r.editorial_participants), complete: Number(r.behind_participants) === 0,
    }));
    await sql`INSERT INTO story_heat_hourly ${sql(values)}
      ON CONFLICT (story_id, hour) DO UPDATE SET heat = EXCLUDED.heat, participants = EXCLUDED.participants,
        cohort = EXCLUDED.cohort, complete = EXCLUDED.complete`;
  }
  return rows.length;
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
  await saveHeat(rows, hour);
  let repaired = 0;
  const stale = await sql<{ hour: Date; stories: number[] }[]>`
    SELECT hour, array_agg(story_id) AS stories FROM story_heat_hourly
    WHERE NOT complete AND hour < ${hour} AND hour > ${new Date(hour.getTime() - WINDOW_HOURS * 3600000)} GROUP BY hour ORDER BY hour`;
  for (const s of stale) {
    const rows = await heatRows(s.hour, behindSources(clocks, s.hour.getTime(), false), s.stories.map(Number));
    repaired += await saveHeat(rows.filter((r) => Number(r.behind_participants) === 0), s.hour);
  }
  return { stories: rows.length, repaired };
}

/**
 * A story's heat hour by hour for its page chart: the hours observed in full over the
 * last `days`, each computed from the current evidence of one group of participants, those whose
 * sources were all collecting before the first plotted hour's window began, so the line compares like
 * with like across the whole plot. No such participant: no line.
 */
export async function heatSeries(storyId: number, now = new Date(), days = 7): Promise<Array<{ hour: Date; heat: number; participants: number }>> {
  const hours = (await sql<{ hour: Date }[]>`
    SELECT hour FROM story_heat_hourly WHERE story_id = ${storyId} AND complete AND hour > ${new Date(now.getTime() - days * 86400_000)} AND hour <= ${now}
    ORDER BY hour`).map((h) => h.hour.getTime());
  if (!hours.length) return [];
  const since = hours[0]! - WINDOW_HOURS * 3600_000;
  const rows = await sql<{ participant_key: string; observed_at: Date; source_since: Date }[]>`
    SELECT participant_key, observed_at, source_since FROM ${currentSignals()} cs
    WHERE story_id = ${storyId} AND observed_at > ${new Date(since)} AND observed_at <= ${now}`;
  const late = new Set(rows.filter((r) => r.source_since.getTime() > since).map((r) => r.participant_key));
  const times = new Map<string, number[]>();
  for (const r of rows) if (!late.has(r.participant_key)) times.set(r.participant_key, [...(times.get(r.participant_key) ?? []), r.observed_at.getTime()]);
  const series = hours.map((hour) => {
    let heat = 0;
    let participants = 0;
    for (const list of times.values()) {
      let last = -Infinity;
      for (const t of list) if (t <= hour && t > hour - WINDOW_HOURS * 3600_000 && t > last) last = t;
      if (last === -Infinity) continue;
      heat += 0.5 ** ((hour - last) / 3600_000 / HALF_LIFE_HOURS);
      participants += 1;
    }
    return { hour: new Date(hour), heat: heatIndex(heat), participants };
  });
  return series.some((p) => p.heat > 0) ? series : [];
}
