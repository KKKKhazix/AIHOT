// The Monday source-health report for the ops chat. It goes through the same gated channel as the
// alerts (off unless FEISHU_INTERNAL_ENABLED).
import { sql } from "../db.ts";
import { beijingDay, sendAlert } from "../notify/feishu.ts";
import { serverModules } from "../modules.ts";

/** The change from b to a: "+12%", "—" without a b. Also the modules' reports. */
export const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "—");
/** A count with thousands separators. */
export const n = (v: number) => v.toLocaleString("en-US");

/** Monday 09:00: how the sources did over the last seven days. */
export async function sourceHealthWeekly(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const before = new Date(now - 14 * 86400_000);
  const [[counts], [items], failing, silent] = await Promise.all([
    sql<{ enabled: number; failing: number; degraded: number; added: number }[]>`
      SELECT count(*) FILTER (WHERE enabled)::int AS enabled,
             count(*) FILTER (WHERE enabled AND health = 'failing')::int AS failing,
             count(*) FILTER (WHERE enabled AND health = 'degraded')::int AS degraded,
             count(*) FILTER (WHERE created_at >= ${since})::int AS added
      FROM sources`,
    sql<{ week: number; prev: number; selected: number }[]>`
      SELECT count(*) FILTER (WHERE discovered_at >= ${since})::int AS week,
             count(*) FILTER (WHERE discovered_at >= ${before} AND discovered_at < ${since})::int AS prev,
             (SELECT count(*)::int FROM publications p WHERE p.selected AND p.visibility <> 'withdrawn' AND p.discovered_at >= ${since}) AS selected
      FROM articles WHERE discovered_at >= ${before}`,
    sql<{ name: string; fail_count: number; last_ok_at: Date | null; last_error: string | null }[]>`
      SELECT name, fail_count, last_ok_at, left(regexp_replace(last_error, '\s+', ' ', 'g'), 80) AS last_error FROM sources
      WHERE enabled AND health = 'failing' ORDER BY fail_count DESC LIMIT 10`,
    // Enabled sources that fetched fine but produced nothing for a week (external and WeChat ones report on their own).
    sql<{ name: string; last: Date | null }[]>`
      SELECT s.name, max(a.discovered_at) AS last FROM sources s LEFT JOIN articles a ON a.source_id = s.id
      WHERE s.enabled AND s.health <> 'failing' AND s.kind NOT IN ('external', 'mp_account') AND s.created_at < ${since}
      GROUP BY s.id, s.name HAVING max(a.discovered_at) IS NULL OR max(a.discovered_at) < ${since}
      ORDER BY max(a.discovered_at) NULLS FIRST LIMIT 15`,
  ]);
  const lines = [
    `本周收录 ${n(items!.week)} 条（上周 ${n(items!.prev)}，${pct(items!.week, items!.prev)}），其中精选 ${n(items!.selected)} 条`,
    `在用信源 ${counts!.enabled} 个，本周新增 ${counts!.added} 个；抓取失败 ${counts!.failing} 个，不太稳定 ${counts!.degraded} 个`,
  ];
  // The modules' own collectors, a line each.
  for (const m of serverModules()) if (m.sourceHealth) lines.push(...(await m.sourceHealth(now)));
  if (failing.length) lines.push("", "抓取失败的信源（这些来源的新内容暂时收不到）：", ...failing.map((f) => `· ${f.name}：连续失败 ${f.fail_count} 次${f.last_ok_at ? `，上次成功 ${beijingDay(f.last_ok_at)}` : ""}${f.last_error ? `（${f.last_error}）` : ""}`));
  if (silent.length) lines.push("", "7 天没有新内容的信源（可能是对方没更新，也可能是抓取方式失效）：", ...silent.map((s) => `· ${s.name}${s.last ? `（最近 ${beijingDay(s.last)}）` : "（从没产出过）"}`));
  lines.push("", failing.length || silent.length ? "需要处理的话，把这条转给 AI；详情在后台“信源”与“运行”页。" : "没有需要处理的信源。");
  await sendAlert("📊 信源周报", lines);
  return { failing: failing.length, silent: silent.length };
}
