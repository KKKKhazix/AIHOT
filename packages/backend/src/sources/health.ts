// Source-health evidence for the daily follow-ups and weekly report. A successful HTTP request is
// not proof of output; discovery channels and editorial publishers are counted separately. What can be
// fixed is followed up daily, one source and problem at a time; quiet sources only weekly.
import { SCHEDULED_AHEAD_MS } from "../content/materials.ts";
import { sql } from "../db.ts";
import { budgetMessage } from "../providers/receipts.ts";

/** How far back a source's own output is read to learn how often it produces something. */
export const RHYTHM_WINDOW_DAYS = 90;
/** Dated days a source needs before its median gap means anything (three gaps). */
export const RHYTHM_MIN_DAYS = 4;
/** How many times its own median gap a source may stay quiet before it looks broken rather than slow. */
export const RHYTHM_MULTIPLE = 4;

/**
 * Failing often enough to be worth fixing, for runs and detail pages alike: at least five failures in the
 * seven days and at least a tenth of the tries. Production, 30 days to 2026-10-17: every source with a
 * broken detail page (500 every time, pages too large, a spent budget) failed 17–100% of its reads.
 * Network errors and the origin's own status are not counted for runs (TRANSIENT): 10-19..11-01 sources at
 * 10–16% of them, healing by the next run, were closed as accepted 21 times; kept up they reach five in a
 * row ("failing"), and many sources at once are content.fetch.
 */
function failsOften(failures: number, tries: number): boolean {
  return failures >= 5 && failures / tries >= 0.1;
}

export interface SourceHealthRow {
  id: string;
  name: string;
  participation_mode: string;
  created_at: Date;
  health: string;
  fail_count: number;
  last_ok_at: Date | null;
  last_error: string | null;
  runs: number;
  failed: number;
  /** Failed runs that are neither TRANSIENT nor a spent budget: the page came back and we could not read it. */
  unusable: number;
  last_unusable_at: Date | null;
  discoveries: number;
  items: number;
  undated: number;
  repeated: number;
  detail_attempts: number;
  detail_failures: number;
  last_failed_at: Date | null;
  last_detail_failure_at: Date | null;
  last_undated_at: Date | null;
  last_repeated_at: Date | null;
  /** Whether this source ever produced an article at all, in or out of the window. */
  ever_output: boolean;
}

/** A quiet source's own rhythm over the rhythm window: read for the quiet sources only, nothing else asks for it. */
export interface QuietSource extends SourceHealthRow {
  /** Days inside the rhythm window this source's own output is dated to; 0 when nothing comparable is in it. */
  evidence_days: number;
  /** Median days between those days; null while there is no rhythm to measure. */
  median_gap_days: number | null;
  /** Whole days since the newest of them; null when nothing comparable is in the window. */
  quiet_days: number | null;
}

export const SOURCE_USE_NAMES: Record<string, string> = { editorial: "编辑内容", hot_signal: "热度信号" };

/** A fixable source problem. */
export type SourceProblem = "failing" | "unstable" | "undated" | "revisions" | "details";
/** Each fixable problem as it is listed, per source: `action` is for the daily follow-up. */
export const SOURCE_PROBLEMS: { problem: SourceProblem; title: string; describe: (s: SourceHealthRow) => string; observedAt: (s: SourceHealthRow) => Date | null; action: string }[] = [
  { problem: "failing", observedAt: s => s.last_failed_at, title: "连续抓取失败", describe: s => `连续失败 ${s.fail_count} 次${s.last_error ? `，${s.last_error}` : ""}`, action: "转给 AI 检查抓取错误" },
  { problem: "unstable", observedAt: s => s.last_unusable_at, title: "反复读不出条目", describe: s => `近 7 天 ${s.unusable}/${s.runs} 次抓到了页面却没解析出条目`, action: "即使最近成功也需检查，避免继续漏收" },
  { problem: "undated", observedAt: s => s.last_undated_at, title: "文章缺发布时间", describe: s => `近 7 天缺发布时间 ${s.undated} 篇`,
    action: "缺时间可能让新闻按历史文章处理" },
  { problem: "revisions", observedAt: s => s.last_repeated_at, title: "文章反复修订", describe: s => `近 7 天反复修订 ${s.repeated} 篇`,
    action: "需核对正文是否混入变化内容" },
  { problem: "details", observedAt: s => s.last_detail_failure_at, title: "详情补全失败", describe: s => `近 7 天失败 ${s.detail_failures}/${s.detail_attempts} 页`, action: "查看抓取记录中的详情地址与错误" },
];

/** A run error that is the network or the origin's answer, not our reading of the page (fetch_runs.error, 10-01..11-01). */
const TRANSIENT = sql`~ ${"^([A-Za-z]*Error: )?(fetch failed|The operation was aborted due to timeout|Client network socket disconnected|other side closed|Connect Timeout Error|DNS lookup failed|((jina|socialdata) )?HTTP [0-9]{3})"}`;

/** Matches a saved error that is a spent provider budget. */
const spentBudget = sql`LIKE ${budgetMessage("%", "%")}`;

/**
 * How many times its own median gap a source has been quiet, or null while its own history is too thin
 * to say: a source with three discoveries in one afternoon has no rhythm, and a daily one has one after
 * a week. A source that never produced anything is null too, and is reported rather than called healthy.
 */
export function rhythmMultiple(s: QuietSource): number | null {
  if (s.evidence_days < RHYTHM_MIN_DAYS || !s.median_gap_days || s.quiet_days === null) return null;
  return s.quiet_days / s.median_gap_days;
}

/** One quiet source in the weekly report: its own numbers, so a reader can see why it is listed. Three
 * cases read differently: output that is only outside the window, output too thin to time, and a source
 * that never gave us anything — a broken collection, or nothing published since it was added. */
export function rhythmText(s: QuietSource): string {
  const times = rhythmMultiple(s);
  if (times === null) {
    const run = `近 7 天 ${s.runs} 次抓取、0 条新内容`;
    if (!s.ever_output) return `${run}；从未收到过内容`;
    return s.evidence_days > 0
      ? `${run}；近 ${RHYTHM_WINDOW_DAYS} 天里只有 ${s.evidence_days} 天发过内容，还看不出固定频率`
      : `${run}；近 ${RHYTHM_WINDOW_DAYS} 天没有发过内容`;
  }
  return `近 ${s.quiet_days} 天没有新内容，平时约 ${s.median_gap_days} 天一条（${Number(times.toFixed(1))} 倍）`;
}

/** Seven days of outcomes, including intermittent failures that a later success clears on sources.
 * Provider budget waits and process shutdowns are not counted as detail failures by the collector.
 * A request timeout remains a failure. */
export async function sourceHealth(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const rows = await sql<SourceHealthRow[]>`
    WITH runs AS (
      SELECT source_id, count(*) FILTER (WHERE status IN ('ok','failed') AND coalesce(error, '') NOT ${spentBudget})::int AS runs,
        count(*) FILTER (WHERE status = 'failed' AND coalesce(error, '') NOT ${spentBudget})::int AS failed,
        coalesce(sum((detail->>'detailAttempts')::int), 0)::int AS detail_attempts,
        coalesce(sum((detail->>'detailFailures')::int), 0)::int AS detail_failures,
        max(coalesce(finished_at, started_at)) FILTER (WHERE status = 'failed' AND coalesce(error, '') NOT ${spentBudget}) AS last_failed_at,
        count(*) FILTER (WHERE status = 'failed' AND coalesce(error, '') NOT ${spentBudget} AND NOT coalesce(error, '') ${TRANSIENT})::int AS unusable,
        max(coalesce(finished_at, started_at)) FILTER (WHERE status = 'failed' AND coalesce(error, '') NOT ${spentBudget} AND NOT coalesce(error, '') ${TRANSIENT}) AS last_unusable_at,
        max(coalesce(finished_at, started_at)) FILTER (WHERE (detail->>'detailFailures')::int > 0) AS last_detail_failure_at
      FROM fetch_runs WHERE started_at >= ${since} GROUP BY source_id
    ), seen AS (
      SELECT article_id, source_id FROM article_discoveries WHERE discovered_at >= ${since}
      UNION SELECT id, source_id FROM articles WHERE discovered_at >= ${since}
    ), discoveries AS (
      SELECT source_id, count(*)::int AS n FROM seen GROUP BY source_id
    ), items AS (
      SELECT source_id, count(*)::int AS n, count(*) FILTER (WHERE published_at IS NULL)::int AS undated,
        max(discovered_at) FILTER (WHERE published_at IS NULL) AS last_undated_at
      FROM articles WHERE discovered_at >= ${since} GROUP BY source_id
    ), revisions AS (
      SELECT article_id, max(created_at) AS last_revision_at FROM article_revisions WHERE created_at >= ${since} AND revision > 1
      GROUP BY article_id HAVING count(*) >= 5
    ), repeated AS (
      SELECT a.source_id, count(*)::int AS n, max(r.last_revision_at) AS last_repeated_at FROM revisions r JOIN articles a ON a.id = r.article_id GROUP BY a.source_id
    )
    SELECT s.id,s.name,s.participation_mode,s.created_at,s.health,s.fail_count,s.last_ok_at,left(s.last_error,200) AS last_error,
      coalesce(r.runs,0) AS runs, coalesce(r.failed,0) AS failed, coalesce(r.unusable,0) AS unusable, r.last_unusable_at, coalesce(r.detail_attempts,0) AS detail_attempts, coalesce(r.detail_failures,0) AS detail_failures,
      coalesce(d.n,0) AS discoveries, coalesce(a.n,0) AS items, coalesce(a.undated,0) AS undated, coalesce(e.n,0) AS repeated,
      r.last_failed_at, r.last_detail_failure_at, a.last_undated_at, e.last_repeated_at,
      (EXISTS (SELECT 1 FROM articles history WHERE history.source_id = s.id)
        OR EXISTS (SELECT 1 FROM article_discoveries history WHERE history.source_id = s.id)) AS ever_output
    FROM sources s LEFT JOIN runs r ON r.source_id = s.id LEFT JOIN discoveries d ON d.source_id = s.id
      LEFT JOIN items a ON a.source_id = s.id LEFT JOIN repeated e ON e.source_id = s.id
    WHERE s.enabled AND s.kind NOT IN ('external','mp_account') AND s.participation_mode IN ('editorial','hot_signal')
    ORDER BY s.name,s.id`;
  // Quiet is the old seven-day signal, kept as the trigger. Whether it is late is now read from the
  // source itself: a monthly blog is quiet for a month between posts without being broken, and a
  // source whose history is too thin to judge stays visible instead of being called fine.
  const quiet = await withRhythm(rows.filter(s => s.created_at < since && s.discoveries === 0), now);
  return Object.entries(SOURCE_USE_NAMES).map(([mode, name]) => {
    const sources = rows.filter(s => s.participation_mode === mode);
    const own = quiet.filter(s => s.participation_mode === mode);
    const overdue = own.flatMap(s => { const times = rhythmMultiple(s); return times !== null && times > RHYTHM_MULTIPLE ? [{ s, times }] : []; })
      .sort((a, b) => b.times - a.times).map(x => x.s);
    return {
      mode, name, sources,
      failing: sources.filter(s => s.health === "failing"),
      /** Failing often without failing now: a source failing now is listed as failing, not twice. */
      unstable: sources.filter(s => s.health !== "failing" && failsOften(s.unusable, s.runs)),
      /** The quiet ones past their own rhythm, most overdue first. */
      overdue,
      /** The quiet ones without enough history to judge, including sources that never produced anything. */
      unknown: own.filter(s => rhythmMultiple(s) === null),
      undated: mode === "editorial" ? sources.filter(s => s.undated > 0) : [],
      revisions: mode === "editorial" ? sources.filter(s => s.repeated > 0) : [],
      details: sources.filter(s => failsOften(s.detail_failures, s.detail_attempts)),
    };
  });
}

/** The given sources' own rhythm, read through their own index entries rather than the whole window. */
async function withRhythm(sources: SourceHealthRow[], now: number): Promise<QuietSource[]> {
  if (!sources.length) return [];
  const rhythmSince = new Date(now - RHYTHM_WINDOW_DAYS * 86400_000);
  const rows = await sql<{ id: string; evidence_days: number; median_gap_days: number | null; quiet_days: number }[]>`
    WITH rhythm AS (
      -- The days inside the window this source's own output is dated to: its publication time when the
      -- page carried one, else the day we found it. A first import is one delivery, so it counts as the
      -- day it arrived however far its publication dates reach back — otherwise one import reads as a
      -- burst of output days (a source that never produced anything looks punctual), and a first import
      -- spread over months would widen the median enough to hide a source that has since gone quiet.
      -- Days outside the window are dropped rather than trusted: older history says nothing about how
      -- often the source produces something now. Candidate reads cover the same whole days as this
      -- window, including posts listed before publication and later filled by fillScheduledPublications.
      SELECT source_id, day FROM (
        SELECT source_id,
          date_trunc('day', CASE WHEN backfill_reason = 'first-import' THEN discovered_at
            ELSE coalesce(published_at, discovered_at) END)::date AS day
        FROM articles WHERE source_id IN ${sql(sources.map(s => s.id))}
          AND discovered_at >= ${rhythmSince}::date - ${SCHEDULED_AHEAD_MS / 1000} * interval '1 second'
        UNION ALL
        SELECT d.source_id, date_trunc('day', d.discovered_at)::date
        FROM article_discoveries d JOIN articles a ON a.id = d.article_id
        WHERE d.source_id IN ${sql(sources.map(s => s.id))} AND d.discovered_at >= ${rhythmSince}::date AND a.source_id <> d.source_id
      ) dated
      WHERE day BETWEEN ${rhythmSince}::date AND ${new Date(now)}::date
    ), rhythm_days AS (
      SELECT DISTINCT source_id, day FROM rhythm
    ), rhythm_gaps AS (
      SELECT source_id, day, day - lag(day) OVER (PARTITION BY source_id ORDER BY day) AS gap FROM rhythm_days
    )
    SELECT source_id AS id, count(*)::int AS evidence_days,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE gap IS NOT NULL) AS median_gap_days,
      (${new Date(now)}::date - max(day))::int AS quiet_days
    FROM rhythm_gaps GROUP BY source_id`;
  const measured = new Map(rows.map(r => [r.id, r]));
  return sources.map(s => {
    const r = measured.get(s.id);
    return { ...s, evidence_days: r?.evidence_days ?? 0, median_gap_days: r?.median_gap_days ?? null, quiet_days: r?.quiet_days ?? null };
  });
}

/** Every listed source with its own numbers. */
export function sourceHealthList<T extends SourceHealthRow>(rows: T[], describe: (row: T) => string): string {
  return rows.map(s => `${s.name}（${s.id}）：${describe(s)}`).join("；");
}
