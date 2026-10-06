// Source-health evidence for the daily follow-ups and weekly report. A successful HTTP request is
// not proof of output; discovery channels and editorial publishers are counted separately.
import { sql } from "../db.ts";
import { budgetMessage } from "../providers/receipts.ts";

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
  discoveries: number;
  items: number;
  undated: number;
  repeated: number;
  detail_failures: number;
}

export const SOURCE_USE_NAMES: Record<string, string> = { editorial: "编辑内容", hot_signal: "热度信号" };

/** Matches a saved error that is a spent provider budget. */
const spentBudget = sql`LIKE ${budgetMessage("%", "%")}`;

/** Seven days of outcomes, including intermittent failures that a later success clears on sources.
 * Provider budget waits and process shutdowns are excluded even when a saved detail run counted
 * them as failures. A request timeout remains a failure. */
export async function sourceHealth(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const rows = await sql<SourceHealthRow[]>`
    WITH runs AS (
      SELECT source_id, count(*) FILTER (WHERE status IN ('ok','failed') AND coalesce(error, '') NOT ${spentBudget})::int AS runs,
        count(*) FILTER (WHERE status = 'failed' AND coalesce(error, '') NOT ${spentBudget})::int AS failed,
        coalesce(sum((detail->>'detailFailures')::int - (
          SELECT count(*) FROM jsonb_array_elements(detail->'detailErrors') e
          WHERE e->>'error' ${spentBudget}
            OR e->>'error' = 'This operation was aborted'
        )), 0)::int AS detail_failures
      FROM fetch_runs WHERE started_at >= ${since} GROUP BY source_id
    ), seen AS (
      SELECT article_id, source_id FROM article_discoveries WHERE discovered_at >= ${since}
      UNION SELECT id, source_id FROM articles WHERE discovered_at >= ${since}
    ), discoveries AS (
      SELECT source_id, count(*)::int AS n FROM seen GROUP BY source_id
    ), items AS (
      SELECT source_id, count(*)::int AS n, count(*) FILTER (WHERE published_at IS NULL)::int AS undated
      FROM articles WHERE discovered_at >= ${since} GROUP BY source_id
    ), revisions AS (
      SELECT article_id FROM article_revisions WHERE created_at >= ${since} AND revision > 1
      GROUP BY article_id HAVING count(*) >= 5
    ), repeated AS (
      SELECT a.source_id, count(*)::int AS n FROM revisions r JOIN articles a ON a.id = r.article_id GROUP BY a.source_id
    )
    SELECT s.id,s.name,s.participation_mode,s.created_at,s.health,s.fail_count,s.last_ok_at,left(s.last_error,200) AS last_error,
      coalesce(r.runs,0) AS runs, coalesce(r.failed,0) AS failed, coalesce(r.detail_failures,0) AS detail_failures,
      coalesce(d.n,0) AS discoveries, coalesce(a.n,0) AS items, coalesce(a.undated,0) AS undated, coalesce(e.n,0) AS repeated
    FROM sources s LEFT JOIN runs r ON r.source_id = s.id LEFT JOIN discoveries d ON d.source_id = s.id
      LEFT JOIN items a ON a.source_id = s.id LEFT JOIN repeated e ON e.source_id = s.id
    WHERE s.enabled AND s.kind NOT IN ('external','mp_account') AND s.participation_mode IN ('editorial','hot_signal')
    ORDER BY s.name,s.id`;
  return Object.entries(SOURCE_USE_NAMES).map(([mode, name]) => {
    const sources = rows.filter(s => s.participation_mode === mode);
    return {
      mode, name, sources,
      failing: sources.filter(s => s.health === "failing"),
      unstable: sources.filter(s => s.failed >= 5 && s.failed / s.runs >= 0.1),
      silent: sources.filter(s => s.created_at < since && s.discoveries === 0),
      quality: mode === "editorial" ? sources.filter(s => s.undated > 0 || s.repeated > 0) : [],
      detailFailures: sources.filter(s => s.detail_failures > 0),
    };
  });
}

/** Bounded display, with the full count explicit; the underlying assessment never drops the tail. */
export function sourceHealthList(rows: SourceHealthRow[], describe: (row: SourceHealthRow) => string, limit = 10): string {
  const list = rows.slice(0, limit).map(s => `${s.name}（${s.id}）：${describe(s)}`).join("；");
  return list + (rows.length > limit ? `；另有 ${rows.length - limit} 个，见后台信源列表` : "");
}
