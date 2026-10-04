// The Monday source-health report for the ops chat. It goes through the same gated channel as the
// alerts (off unless FEISHU_INTERNAL_ENABLED).
import { sql } from "../db.ts";
import { sendAlert } from "../notify/feishu.ts";
import { serverModules } from "../modules.ts";
import { sourceHealth, sourceHealthList } from "../sources/health.ts";

/** The change from b to a: "+12%", "—" without a b. Also the modules' reports. */
export const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "—");
/** A count with thousands separators. */
export const n = (v: number) => v.toLocaleString("en-US");

/** Monday 09:00: how the sources did over the last seven days. */
export async function sourceHealthWeekly(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const before = new Date(now - 14 * 86400_000);
  const [[counts], [items], groups] = await Promise.all([
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
    sourceHealth(now),
  ]);
  const lines = [
    `本周收录 ${n(items!.week)} 条（上周 ${n(items!.prev)}，${pct(items!.week, items!.prev)}），其中精选 ${n(items!.selected)} 条`,
    `在用信源 ${counts!.enabled} 个，本周新增 ${counts!.added} 个；抓取失败 ${counts!.failing} 个，不太稳定 ${counts!.degraded} 个`,
  ];
  // The modules' own collectors, a line each.
  for (const m of serverModules()) if (m.sourceHealth) lines.push(...(await m.sourceHealth(now)));
  for (const group of groups) {
    lines.push("", `${group.name}：${group.sources.length} 个在用信源；本周归属条目 ${n(group.sources.reduce((sum, s) => sum + s.items, 0))} 条；连续失败 ${group.failing.length} 个、反复失败 ${group.unstable.length} 个、7 天无新发现 ${group.silent.length} 个`);
    if (group.failing.length) lines.push(`抓取失败：${sourceHealthList(group.failing, s => `连续失败 ${s.fail_count} 次${s.last_error ? `（${s.last_error}）` : ""}`, Infinity)}`);
    if (group.unstable.length) lines.push(`不稳定：${sourceHealthList(group.unstable, s => `失败 ${s.failed}/${s.runs} 次`, Infinity)}`);
    if (group.silent.length) lines.push(`7 天无新发现（需对照原站，可能只是低频更新）：${sourceHealthList(group.silent, s => `${s.runs} 次抓取`, Infinity)}`);
    if (group.quality.length) lines.push(`文章质量待核实：${sourceHealthList(group.quality, s => `缺发布时间 ${s.undated} 篇、反复修订 ${s.repeated} 篇`, Infinity)}`);
    if (group.detailFailures.length) lines.push(`详情补全失败：${sourceHealthList(group.detailFailures, s => `${s.detail_failures} 次`, Infinity)}`);
  }
  const failing = counts!.failing;
  const silent = groups.reduce((sum, g) => sum + g.silent.length, 0);
  const followUp = counts!.failing > 0 || groups.some(g => g.failing.length || g.unstable.length || g.silent.length || g.quality.length || g.detailFailures.length);
  lines.push("", followUp ? "需要处理的话，把这条转给 AI；详情在后台“信源”与“运行”页。" : "没有需要处理的信源。");
  await sendAlert("📊 信源周报", lines);
  return { failing, silent };
}
