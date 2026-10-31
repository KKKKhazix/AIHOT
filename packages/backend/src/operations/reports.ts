// The Monday source-health report for the ops chat. It goes through the same gated channel as the
// alerts (off unless FEISHU_INTERNAL_ENABLED).
import { beijingDay } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { sendAlert } from "../notify/feishu.ts";
import { serverModules } from "../modules.ts";
import { rhythmText, SOURCE_PROBLEMS, sourceHealth, sourceHealthList } from "../sources/health.ts";
import { dismissedFollowUps } from "./alerts.ts";

/** The change from b to a: "+12%", "—" without a b. Also the modules' reports. */
export const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "—");
/** A count with thousands separators. */
export const n = (v: number) => v.toLocaleString("en-US");

/** Who changed a source, as the owner reads it: the admin pages, or the AI's scripts. */
const by = (actor: string) => actor.startsWith("admin:") ? "后台" : /^(ops-script|codex)/.test(actor) ? "AI" : actor;
const brief = (reason: string | null) => !reason ? "没写原因" : [...reason].length > 60 ? `${[...reason].slice(0, 60).join("")}…` : reason;
const excluded = (config: unknown) => {
  const c = (config ?? {}) as { denyUrlPrefixes?: string[]; denyCategories?: string[] };
  return [...(c.denyUrlPrefixes ?? []), ...(c.denyCategories ?? [])];
};

/**
 * This week's pauses still in force and the exclusions added, with who and why. Agents pause and exclude on
 * their own, and nothing else shows a wrong one (10-21 a flaky feed paused at noon, noticed only that evening).
 */
async function sourceChanges(since: Date): Promise<string[]> {
  const rows = await sql<{ id: string; name: string; enabled: boolean; actor: string; reason: string | null; at: Date; before: { enabled?: boolean; config?: unknown } | null; after: { enabled?: boolean; config?: unknown } | null }[]>`
    SELECT s.id, s.name, s.enabled, a.actor, a.reason, a.created_at AS at, a.before, a.after
    FROM audit_log a JOIN sources s ON a.subject = 'source:' || s.id
    WHERE a.action = 'source.update' AND a.created_at >= ${since} ORDER BY a.created_at, a.id`;
  const paused = new Map<string, string>();
  const fenced: string[] = [];
  const fencedIds = new Set<string>();
  for (const r of rows) {
    const who = `${by(r.actor)}，${beijingDay(r.at)}`;
    // The audit keeps the fields a save sent; a form saved again on a paused source repeats enabled=false.
    if (r.after?.enabled === false && r.before?.enabled !== false && !r.enabled) paused.set(r.id, `· ${r.name}（${who}）：${brief(r.reason)}`);
    const added = excluded(r.after?.config).filter((rule) => !excluded(r.before?.config).includes(rule));
    if (added.length) {
      fenced.push(`· ${r.name}（${who}，排除 ${added.join("、")}）：${brief(r.reason)}`);
      fencedIds.add(r.id);
    }
  }
  return [
    ...(paused.size ? [`本周停用、现在仍停着的信源 ${paused.size} 个：`, ...paused.values()] : []),
    ...(fenced.length ? [`本周排除了部分入口的信源 ${fencedIds.size} 个：`, ...fenced] : []),
  ];
}

/** Monday 09:00: how the sources did over the last seven days, quiet ones included (the daily follow-ups leave them out). */
export async function sourceHealthWeekly(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const before = new Date(now - 14 * 86400_000);
  const [[counts], [items], groups, dismissed] = await Promise.all([
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
    dismissedFollowUps(),
  ]);
  const lines = [
    `本周收录 ${n(items!.week)} 条（上周 ${n(items!.prev)}，${pct(items!.week, items!.prev)}），其中精选 ${n(items!.selected)} 条`,
    `在用信源 ${counts!.enabled} 个，本周新增 ${counts!.added} 个；抓取失败 ${counts!.failing} 个，不太稳定 ${counts!.degraded} 个`,
  ];
  // The modules' own collectors, a line each.
  for (const m of serverModules()) if (m.sourceHealth) lines.push(...(await m.sourceHealth(now)));
  for (const group of groups) {
    lines.push("", `${group.name}：${group.sources.length} 个在用信源；本周归属条目 ${n(group.sources.reduce((sum, s) => sum + s.items, 0))} 条；连续失败 ${group.failing.length} 个、反复失败 ${group.unstable.length} 个、超出自身更新节奏 ${group.overdue.length} 个、7 天没有新内容 ${group.unknown.length} 个`);
    for (const p of SOURCE_PROBLEMS) {
      if (!group[p.problem].length) continue;
      lines.push(`${p.title}：${sourceHealthList(group[p.problem], s => {
        const dismissal = dismissed[`sources.${p.problem}.${s.id}`];
        return p.describe(s) + (dismissal ? `（已判定不修：${dismissal.reason}）` : "");
      })}`);
    }
    if (group.overdue.length) lines.push(`超出自身更新节奏（先对照原站，区分采集失效与它自己变慢）：${sourceHealthList(group.overdue, rhythmText)}`);
    if (group.unknown.length) lines.push(`7 天没有新内容（窗口内产出历史不足以判断节奏，或从未收到内容）：${sourceHealthList(group.unknown, rhythmText)}`);
  }
  const changes = await sourceChanges(since);
  if (changes.length) lines.push("", ...changes);
  const failing = counts!.failing;
  const overdue = groups.reduce((sum, g) => sum + g.overdue.length, 0);
  // Quiet sources still worth a look: past their own rhythm, or not judgeable.
  const silent = overdue + groups.reduce((sum, g) => sum + g.unknown.length, 0);
  const followUp = counts!.failing > 0 || silent > 0 || groups.some(g => g.failing.length || g.unstable.length || g.undated.length || g.revisions.length || g.details.length);
  lines.push("", followUp ? "需要处理的话，把这条转给 AI；详情在后台“信源”与“运行”页。" : "没有需要处理的信源。");
  await sendAlert("📊 信源周报", lines);
  return { failing, silent, overdue };
}
