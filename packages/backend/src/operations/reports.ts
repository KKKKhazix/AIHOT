// The Monday source-health report for the ops chat. It goes through the same gated channel as the
// alerts (off unless FEISHU_INTERNAL_ENABLED).
import { beijingDay } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { sendAlert } from "../notify/feishu.ts";
import { serverModules } from "../modules.ts";
import { useLabels } from "../sources/uses.ts";

/** Sources that serve modules only (out of the news, with uses): counted and named apart from the news sources. */
const moduleOnly = sql`(participation_mode = 'isolated' AND uses <> '{}')`;
const usesText = (uses: string[]) => uses.map((u) => useLabels()[u] ?? u).join("、");

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
  const rows = await sql<{ id: string; name: string; enabled: boolean; module_only: boolean; uses: string[]; actor: string; reason: string | null; at: Date; before: { enabled?: boolean; config?: unknown } | null; after: { enabled?: boolean; config?: unknown } | null }[]>`
    SELECT s.id, s.name, s.enabled, ${moduleOnly} AS module_only, s.uses, a.actor, a.reason, a.created_at AS at, a.before, a.after
    FROM audit_log a JOIN sources s ON a.subject = 'source:' || s.id
    WHERE a.action = 'source.update' AND a.created_at >= ${since} ORDER BY a.created_at, a.id`;
  const paused = new Map<string, string>();
  const fenced: string[] = [];
  const fencedIds = new Set<string>();
  for (const r of rows) {
    const who = `${by(r.actor)}，${beijingDay(r.at)}${r.module_only ? `，只给${usesText(r.uses)}用` : ""}`;
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

/**
 * Monday 09:00: the week in a few lines, and what agents changed. Per-source lists stay out: nobody can act on
 * 160 quiet sources in a chat message; the Monday patrol checks them from sourceHealth(), the daily follow-ups name failures.
 */
export async function sourceHealthWeekly(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const before = new Date(now - 14 * 86400_000);
  const [[counts], [items], served] = await Promise.all([
    sql<{ enabled: number; failing: number; degraded: number; added: number }[]>`
      SELECT count(*) FILTER (WHERE enabled)::int AS enabled,
             count(*) FILTER (WHERE enabled AND health = 'failing')::int AS failing,
             count(*) FILTER (WHERE enabled AND health = 'degraded')::int AS degraded,
             count(*) FILTER (WHERE created_at >= ${since})::int AS added
      FROM sources WHERE NOT ${moduleOnly}`,
    sql<{ week: number; prev: number; selected: number }[]>`
      SELECT count(*) FILTER (WHERE discovered_at >= ${since})::int AS week,
             count(*) FILTER (WHERE discovered_at >= ${before} AND discovered_at < ${since})::int AS prev,
             (SELECT count(*)::int FROM publications p WHERE p.selected AND p.visibility <> 'withdrawn' AND p.discovered_at >= ${since}) AS selected
      FROM articles WHERE discovered_at >= ${before} AND source_id NOT IN (SELECT id FROM sources WHERE ${moduleOnly})`,
    sql<{ uses: string[]; failing: boolean }[]>`SELECT uses, health = 'failing' AS failing FROM sources WHERE enabled AND ${moduleOnly}`,
  ]);
  const lines = [
    `本周收录 ${n(items!.week)} 条（上周 ${n(items!.prev)}，${pct(items!.week, items!.prev)}），其中精选 ${n(items!.selected)} 条`,
    `在用信源 ${counts!.enabled} 个，本周新增 ${counts!.added} 个；抓取失败 ${counts!.failing} 个，不太稳定 ${counts!.degraded} 个`,
  ];
  if (served.length) {
    const perUse = new Map<string, number>();
    for (const s of served) for (const u of s.uses) perUse.set(u, (perUse.get(u) ?? 0) + 1);
    const each = [...perUse].map(([u, count]) => `${usesText([u])} ${count}`).join("、");
    lines.push(`另有只给模块用的信源 ${served.length} 个（${each}），抓取失败 ${served.filter((s) => s.failing).length} 个`);
  }
  // The modules' own collectors, a line each.
  for (const m of serverModules()) if (m.sourceHealth) lines.push(...(await m.sourceHealth(now)));
  const changes = await sourceChanges(since);
  if (changes.length) lines.push("", ...changes);
  await sendAlert("📊 信源周报", lines);
  return { failing: counts!.failing };
}
