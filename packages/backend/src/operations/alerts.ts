// Operations alerts. The person reading them is the site owner, not an engineer: each
// message says what readers see, whether it heals by itself and what, if anything, the owner must do.
//   now   — readers are affected and it has not healed: sent at once, repeated hourly, recovery reported.
//   today — money at risk or only the owner can act: sent at once, repeated at most daily, recovery reported.
//   later — other follow-ups: one 09:00 list a day for the agent (the owner's only without one). A source's follow-up is
//           closed on its own: a fix removes it, and one judged not worth fixing is closed with a reason.
// A finding with agentOnly is still now or today, but it only wakes the agent: nothing is sent when it
// opens, nothing is sent when it clears, and it stays off the 09:00 digest.
// A module can name those alerts as well, including `name:<item>`, so a row saved before the flag still closes quietly.
// With an agent taking the alerts (notify/agent.ts), a now or today problem that is not the owner's own
// (Finding.owner) is handed to the agent instead. The owner hears of it when the same problem is handed over
// a third time in a day, or when it is still open HANDED_MS after the handoff, and from then on as above;
// an incident the agent judged not a fault (holdAlert) is not told before its hold ends. The agent is not
// woken for what is the owner's alone (owner "only"). While the channel to the agent fails, the owner hears everything again.
// The shared hub owns serial execution and retry; accepted events are never dispatched again here.
// Delivery goes through sendAlert (alert webhook or ops chat, internal-chat fallback; off unless FEISHU_INTERNAL_ENABLED).
import { addDays, beijingAt, beijingDate, beijingDay, beijingStamp, isValidDate } from "@aihot/contracts/time";
import { ALERTS, EDITION_TIMES } from "@aihot/site";
import { audit } from "../audit.ts";
import { sql } from "../db.ts";
import { agentConfigured, agentTransportFindings, flushAgentEvents, handoffs, wakeAgent, wakeDigest } from "../notify/agent.ts";
import { duration, formatAlert, formatRecovery, formatReturn, sendAlert, type Finding, type Level } from "../notify/feishu.ts";
import { stepsOnService } from "../editorial/models.ts";
import { backupConfigured } from "./backup.ts";
import { GROUPING_WARN_AFTER_MS, waitingSelectedNews } from "./grouping.ts";
import { upstreamFindings } from "../media/upstream.ts";
import { serverModules } from "../modules.ts";
import { awaitingRelease, providerAccessRefused } from "../providers/receipts.ts";
import { SOURCE_PROBLEMS, sourceHealth } from "../sources/health.ts";

const REPEAT_MS: Record<Exclude<Level, "later">, number> = { now: 3600_000, today: 24 * 3600_000 };
/**
 * How long the agent has a problem before the owner hears of it too: readers affected now, the first hourly
 * reminder; otherwise time to ship a fix and retry it once (10-19..10-21 the agent closed its alerts within 25 minutes).
 */
const HANDED_MS: Record<Exclude<Level, "later">, number> = { now: 3600_000, today: 3 * 3600_000 };
/** The handoff that tells the owner a problem keeps coming back, counted over a day; told at most once a day. */
const RETURNS = 3;
const DAY_MS = 86_400_000;

// Valves default off: read at call time, only an explicit "true" turns them on.
const collecting = () => process.env.COLLECT_ENABLED === "true";
const modelsOn = () => process.env.MODEL_CALLS_ENABLED === "true";
/**
 * How long the site may go without a new article before it counts as stalled (ALERT_QUIET_MINUTES, else
 * the site's own setting; small source lists are quieter). At most a day: the check looks one day back.
 */
const QUIET_MINUTES = Math.min(Number(process.env.ALERT_QUIET_MINUTES || ALERTS.quietMinutes), 1440);

/** One check: the problems it finds now. `open` retains ongoing incidents, read once per round. */
type Check = (now: number, open: AlertState) => Promise<Finding[]>;

/** Everything checked every round, in the order the findings are listed. */
const CHECKS: Check[] = [
  // Readers affected now
  contentCollection,
  sourcesFailing,
  selectedGrouping,
  contentProcessing,
  dailyReportFindings,
  // Money, and things only the owner can do
  providerFindings,
  refusedDeliveries,
  backupAge,
  upstreamFindings,
  moduleAlerts,
  // Follow-ups
  sourceFollowUps,
  unknownOutcomes,
  agentTransportFindings,
  waitingQueues,
  moduleFollowUps,
];

/** Everything wrong right now, with its level. */
export async function collectFindings(now = Date.now(), open?: AlertState): Promise<Finding[]> {
  const announced = open ?? await alertState();
  const out: Finding[] = [];
  for (const check of CHECKS) out.push(...(await check(now, announced)));
  return out;
}

// Content flow, judged by outcome: whatever broke (worker, egress proxy, models, queues), readers see
// a site that stops changing. Its persisted backlog survives worker restarts and paused valves.
async function contentCollection(now: number, open: AlertState): Promise<Finding[]> {
  if (!collecting() && !open["content.collect"]) return [];
  const [last] = await sql<{ at: Date | null }[]>`SELECT max(a.discovered_at) AS at FROM articles a
    JOIN sources s ON s.id = a.source_id WHERE s.participation_mode = 'editorial' AND a.discovered_at > now() - interval '1 day'`;
  if (last?.at && now - last.at.getTime() <= QUIET_MINUTES * 60_000) return [];
  // A site without an enabled source has nothing to collect.
  const [anySource] = await sql`SELECT 1 FROM sources WHERE enabled AND participation_mode = 'editorial' LIMIT 1`;
  if (!anySource) return [];
  return [{
    key: "content.collect",
    level: "now",
    title: "网站停止收录新文章",
    impact: last?.at ? `读者看不到新文章：最后一篇收录于 ${beijingStamp(last.at)}` : "读者看不到新文章：一天内没有收录任何文章",
    heals: ALERTS.usualFlow ? `没有，${ALERTS.usualFlow}` : "没有",
    action: "尽快发起一次维护处理",
    detail: `editorial articles.discovered_at 超过 ${QUIET_MINUTES} 分钟没有新值（热度信号单独评估）；查 sources.schedule、出网代理与采集失败`,
    since: last?.at ?? undefined,
  }];
}

/**
 * Many sources failing at once points at the site's way out, not at the sources: the site keeps changing
 * with what still works, so the stall above stays quiet. Each enabled source counts by its latest fetch,
 * however long ago: a failing one waits hours before it is fetched again, and collection may be paused or the
 * worker down meanwhile, so only a fetch that works again is recovery. Production, 30 days to 2026-10-28:
 * the egress proxy dropped on 10-05, 10-17 and 10-26 and 23–37% of the sources were failing at the worst;
 * at no other time more than 11.5%. Fewer than 50 failing sources are each one's own follow-up.
 */
const FAILING_SHARE = 0.15;
const FAILING_SOURCES = 50;

async function sourcesFailing(now: number, open: AlertState): Promise<Finding[]> {
  if (!collecting() && !open["content.fetch"]) return [];
  const latest = sql`SELECT r.status, r.error, r.started_at FROM sources s CROSS JOIN LATERAL (
      SELECT status, error, started_at FROM fetch_runs f
      WHERE f.source_id = s.id AND f.status IN ('ok', 'failed') AND f.started_at <= ${new Date(now)}
      ORDER BY started_at DESC LIMIT 1) r
    WHERE s.enabled`;
  const [r] = await sql<{ fetched: number; failing: number }[]>`
    SELECT count(*)::int AS fetched, count(*) FILTER (WHERE status = 'failed')::int AS failing FROM (${latest}) l`;
  if (!r || r.failing < FAILING_SOURCES || r.failing < r.fetched * FAILING_SHARE) return [];
  const errors = await sql<{ error: string; n: number; first: Date }[]>`
    SELECT left(coalesce(error, ''), 120) AS error, count(*)::int AS n, min(started_at) AS first FROM (${latest}) l
    WHERE status = 'failed' GROUP BY 1 ORDER BY 2 DESC`;
  return [{
    key: "content.fetch",
    level: "now",
    title: "大量信源抓取失败，这些信源的新文章进不来",
    impact: `最近抓取过的 ${r.fetched} 个信源里，${r.failing} 个最近一次抓取失败，读者暂时看不到它们的新文章`,
    heals: "服务器连外网的线路恢复后会按排程重新抓取，这段时间的新文章会晚到；线路不恢复就一直进不来",
    action: "转给 AI 检查出网代理和抓取错误",
    detail: `失败信源占 ${Math.round((r.failing / r.fetched) * 100)}%（门槛 ${FAILING_SHARE * 100}% 且至少 ${FAILING_SOURCES} 个）；常见错误：${errors.slice(0, 3).map((e) => `${e.error || "（无）"} ×${e.n}`).join("；")}`,
    since: new Date(Math.min(...errors.map((e) => e.first.getTime()))),
  }];
}

/** Processing is checked while collection and models run, and while either of its incidents is open. */
const watchingProcessing = (open: AlertState) => (collecting() && modelsOn()) || !!open["content.grouping"] || !!open["content.process"];

async function selectedGrouping(now: number, open: AlertState): Promise<Finding[]> {
  if (!watchingProcessing(open)) return [];
  const waiting = (await waitingSelectedNews()).filter((item) => open["content.grouping"] || now - item.since.getTime() >= GROUPING_WARN_AFTER_MS);
  if (!waiting.length) return [];
  const manual = waiting.filter((item) => item.recovery === "manual").length;
  const receipt = waiting.some((item) => item.recovery === "receipt");
  return [{
    key: "content.grouping",
    level: "now",
    title: "有精选新闻卡在去重确认，暂未发布",
    impact: `${waiting.length} 条已达到精选条件的新闻仍未完成去重确认，还没进入精选，读者可能晚看到这些更新`,
    heals: manual ? `${manual} 条需要人工处理后才能恢复${manual < waiting.length ? "；其余仍在自动恢复" : ""}`
      : receipt ? "仍在等待自动恢复；付费结果未知的请求会在 30 分钟后自动放行一次" : "还会自动重试，但等待已经超过正常范围",
    action: manual ? "转给 AI 处理；核对计费，或在已有恢复授权内如实记录计费未知后放行" : "转给 AI 检查等待原因，避免继续积压",
    detail: waiting.slice(0, 8).map((item) => `${item.articleId}${item.receiptId ? ` 回执 #${item.receiptId}` : ""}${item.error ? `：${item.error.slice(0, 120)}` : ""}`).join("；"),
    since: waiting[0]!.since,
  }];
}

async function contentProcessing(now: number, open: AlertState): Promise<Finding[]> {
  if (!watchingProcessing(open)) return [];
  // An article still new two hours after discovery is overdue, and one failed in the last three hours counts.
  // While an announced incident is open, the windows stay where its first detection put them: time passing
  // cannot remove unfinished articles from it. The alert's duration starts at detection, not article age.
  const incident = open["content.process"];
  const detectedAt = incident ? Math.min(now, Date.parse(incident.since)) : now;
  const overdueBefore = now - 2 * 3600_000;
  const waitingAfter = new Date(detectedAt - 2 * 86400_000);
  const waitingBefore = new Date(incident ? Math.max(overdueBefore, detectedAt) : overdueBefore);
  const failedAfter = new Date(detectedAt - 3 * 3600_000);
  const unfinished = sql`(processing_state = 'new' AND discovered_at > ${waitingAfter} AND discovered_at < ${waitingBefore})
    OR (processing_state = 'failed' AND discovered_at > ${failedAfter})`;
  const [p] = await sql<{ waiting: number; failed: number; oldest: Date | null }[]>`
    SELECT count(*) FILTER (WHERE processing_state = 'new')::int AS waiting,
           count(*) FILTER (WHERE processing_state = 'failed')::int AS failed,
           min(discovered_at) FILTER (WHERE processing_state = 'new') AS oldest
    FROM articles WHERE ${unfinished}`;
  if (p!.waiting < 10 && p!.failed < 20 && !(incident && p!.waiting + p!.failed > 0)) return [];
  const errors = await sql<{ error: string; n: number }[]>`
    SELECT left(coalesce(processing_error, '（无）'), 120) AS error, count(*)::int AS n FROM articles
    WHERE (${unfinished}) AND processing_error IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 3`;
  return [{
    key: "content.process",
    level: "now",
    title: "新内容卡住了，进不了网站",
    impact: [p!.waiting > 0 && `${p!.waiting} 篇积压文章仍在等待处理`, p!.failed > 0 && `${p!.failed} 篇处理失败的文章仍未补齐`]
      .filter(Boolean)
      .join("；") + "，精选和热点会缺内容",
    heals: p!.failed > 0 ? "已失败的文章需要恢复处理；服务恢复不代表积压已经补齐" : "排队中的文章会继续处理，仍需核实是否完成",
    action: "转给 AI 处理",
    // Article age is useful detail; incident duration starts at first detection.
    detail: [p!.oldest && `最老的一篇 ${beijingStamp(p!.oldest)} 收进`, errors.map((e) => `${e.error}（${e.n}）`).join("；") || "没有记录错误"].filter(Boolean).join("；"),
  }];
}

// Content-group pushes the Feishu webhook refused (a removed bot, a changed address); nothing resends them.
async function refusedDeliveries(now: number, open: AlertState): Promise<Finding[]> {
  const incident = open["deliveries.failed"];
  const since = new Date((incident ? Date.parse(incident.since) : now) - 86400_000);
  const [refused] = await sql<{ n: number; target: string | null; response: string | null }[]>`
    SELECT count(*)::int AS n, max(t.note) AS target, left(max(d.response), 200) AS response FROM deliveries d JOIN notify_targets t ON t.key = d.target_key
    WHERE d.updated_at > ${since}
      AND (d.status = 'failed' OR (${!!incident} AND (d.status = 'unknown' OR (d.status IN ('pending','sending') AND d.attempts > 0))))
      AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'delivery.drop'
        AND a.subject = 'delivery:' || d.id AND a.created_at >= d.updated_at)`;
  if (!refused!.n) return [];
  return [{
    key: "deliveries.failed",
    level: "today",
    title: "飞书内容群有推送没发出去",
    impact: `${refused!.n} 条通知尚未确认送达${refused!.target ?? "内容群"}`,
    heals: "不会自动重发",
    action: "转给 AI 处理；如果推送机器人被移出了群，需要你把它加回去",
    detail: refused!.response ?? "",
  }];
}

async function backupAge(now: number): Promise<Finding[]> {
  if (!backupConfigured()) return [];
  const [b] = await sql<{ value: { at: string; uploaded: boolean; filesError?: string } }[]>`SELECT value FROM settings WHERE key = 'backup.last'`;
  // A failed archive updates backup.last too. Reuse the run history so repeated failures cannot
  // reset the age; before the first success, count from the first attempt rather than from now.
  const [runs] = await sql<{ last_ok: Date | null; first_attempt: Date | null }[]>`
    SELECT max(finished_at) FILTER (WHERE status = 'ok') AS last_ok, min(started_at) AS first_attempt
    FROM job_runs WHERE job = 'ops.backup'`;
  const lastOk = Math.max(runs?.last_ok?.getTime() ?? 0, b?.value.uploaded ? Date.parse(b.value.at) : 0);
  const since = lastOk || runs?.first_attempt?.getTime() || now;
  const age = now - since;
  const state = b?.value.filesError ? `数据库已上传，附件打包失败：${b.value.filesError}` : b?.value.uploaded === false ? "未上传" : "";
  if (age > 50 * 3600_000) {
    return [{
      key: "backup.failed",
      level: "today",
      title: "数据库备份连续两天没成功",
      impact: lastOk ? `万一服务器出事，最近 ${duration(age)} 的数据可能无法完整恢复` : "还没有成功的完整备份，服务器出事时可能无法恢复数据",
      heals: "不会",
      action: "转给 AI 处理",
      detail: `${lastOk ? "最近一次成功" : "首次备份尝试"} ${beijingStamp(since)}${state ? `；${state}` : ""}；看 ops.backup 的运行记录`,
      since: new Date(since),
    }];
  }
  if (!b || !b.value.uploaded || age > 30 * 3600_000) {
    return [{ key: "backup.stale", level: "later", title: "数据库备份超过一天没成功", detail: b ? `最近一次 ${beijingStamp(b.value.at)}${state ? `（${state}）` : ""}；看 ops.backup` : "还没有成功的备份记录" }];
  }
  return [];
}

/** What the site's modules find. */
async function moduleAlerts(now: number): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const m of serverModules()) if (m.alerts) out.push(...(await m.alerts(now)));
  return out;
}

/** A module declared this alert agent-only. `name` also covers each `name:<item>`. */
function moduleAgentOnly(key: string): boolean {
  return serverModules().some((m) => m.agentOnly?.some((name) => key === name || key.startsWith(`${name}:`)));
}

/**
 * One follow-up per source and problem, so fixing a source removes its own line. A quiet source is left to
 * the weekly report: being slow, or too new to have a rhythm, is nothing anyone can fix, and may never end.
 */
async function sourceFollowUps(now: number): Promise<Finding[]> {
  if (!collecting()) return [];
  return (await sourceHealth(now)).flatMap(group => SOURCE_PROBLEMS.flatMap(p => group[p.problem].map((s): Finding => ({
    key: `sources.${p.problem}.${s.id}`, level: "later", title: `${group.name}信源「${s.name}」${p.title}`,
    detail: `${s.id}：${p.describe(s)}；${p.action}`, observedAt: p.observedAt(s) ?? undefined,
  }))));
}

/** Paid requests and content-group pushes whose outcome is not known yet. */
async function unknownOutcomes(): Promise<Finding[]> {
  const out: Finding[] = [];

  const [r] = await sql<{ receipts: number; services: string | null; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE ${awaitingRelease()}) AS receipts,
           (SELECT string_agg(DISTINCT service || '/' || purpose, '、') FROM receipts WHERE ${awaitingRelease()}) AS services,
           (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS deliveries`;
  if (r!.receipts > 0) {
    out.push({ key: "receipts.unknown", level: "later", title: `${r!.receipts} 个付费请求的结果尚未确认`, detail: `${r!.services}；后台“运行”页查看实际影响；仍阻塞内容的请求需核对或按已有授权恢复` });
  }
  if (r!.deliveries > 0) out.push({ key: "deliveries.unknown", level: "later", title: `${r!.deliveries} 条飞书内容群推送不确定是否送达`, detail: "后台“运行”页核对群里有没有，再标记或重发" });
  return out;
}

/** Runnable jobs (deferred ones excluded) that have waited more than two hours. */
async function waitingQueues(now: number): Promise<Finding[]> {
  const queues = await sql<{ name: string; n: number; oldest: Date }[]>`
    SELECT name, count(*)::int AS n, min(start_after) AS oldest FROM pgboss.job
    WHERE state IN ('created', 'retry') AND start_after <= now() AND name NOT LIKE 'cron.%' GROUP BY 1`;
  return queues.filter((q) => now - q.oldest.getTime() > 2 * 3600_000).map((q): Finding => (
    { key: `queue.${q.name}`, level: "later", title: `后台任务排队超过 2 小时：${q.name}`, detail: `${q.n} 个等待，最早的等了 ${duration(now - q.oldest.getTime())}` }));
}

/** The site's modules' follow-ups. */
async function moduleFollowUps(now: number): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const m of serverModules()) if (m.followUps) out.push(...(await m.followUps(now)));
  return out;
}

/** Current routing describes possible impact; recent failed calls do not prove every step has stopped. */
async function modelStops(service: string, models?: ReadonlySet<string>): Promise<string> {
  const steps = await stepsOnService(service, models);
  return steps.length ? `${steps.join("、")}可能受影响` : "当前没有处理步骤使用这家模型服务";
}
/** `stops` is for the services that are not models; a model service's follows from the steps that use it. */
const PROVIDERS: Record<string, { name: string; where: string; stops?: string }> = {
  llm: { name: "默认模型服务", where: "模型服务商的控制台" },
  zhipu: { name: "智谱", where: "智谱开放平台" },
  dashscope: { name: "阿里云百炼", where: "阿里云百炼控制台" },
  deepseek: { name: "DeepSeek", where: "DeepSeek 开放平台" },
  mimo: { name: "小米 MiMo", where: "小米 MiMo 开放平台" },
  socialdata: { name: "SocialData", stops: "X（推特）上的新内容收不到", where: "SocialData 后台" },
  jina: { name: "Jina", stops: "部分文章取不到正文", where: "Jina 后台" },
  dajiala: { name: "极致了（Dajiala）", stops: "公众号新文章收不到", where: "极致了后台" },
};
export const providerName = (service: string) => PROVIDERS[service]?.name ?? service;
export const providerStops = async (service: string, models?: ReadonlySet<string>): Promise<string> => {
  const p = PROVIDERS[service];
  return p ? (p.stops ?? modelStops(service, models)) : "相关功能停了";
};
export const providerConsole = (service: string) => PROVIDERS[service]?.where ?? `${service} 后台`;

const REFUSED_PREFIX = "provider.refused.";

/** Paid services that refuse us (no balance, a dead key), and daily budgets used up. */
async function providerFindings(now: number, open: AlertState): Promise<Finding[]> {
  const out: Finding[] = [];
  const ongoing = Object.keys(open).filter(key => key.startsWith(REFUSED_PREFIX)).map(key => key.slice(REFUSED_PREFIX.length).split(":")[0]!);
  const failures = await sql<{ service: string; model: string | null; error: string; n: number; latest: Date }[]>`
    SELECT service, model, error, count(*)::int AS n, max(started_at) AS latest FROM receipt_attempts a
    WHERE status = 'failed' AND (started_at > ${new Date(now - 3600_000)} OR service = ANY(${ongoing})) AND error IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts good WHERE good.service = a.service AND good.model IS NOT DISTINCT FROM a.model AND good.status = 'received' AND good.started_at > a.started_at)
    GROUP BY service, model, error ORDER BY latest DESC`;
  const models = new Map<string, { service: string; model: string | null; n: number; last: string; latest: number }>();
  for (const p of failures) {
    if (!providerAccessRefused(p.service, p.error)) continue;
    const key = `${REFUSED_PREFIX}${p.service}${p.model === null ? "" : `:${encodeURIComponent(p.model)}`}`;
    const summary = models.get(key) ?? { service: p.service, model: p.model, n: 0, last: p.error.slice(0, 200), latest: p.latest.getTime() };
    summary.n += p.n;
    models.set(key, summary);
  }
  // Earlier versions combined every model under a service key without saving its scope. Freeze the
  // unresolved models once for those existing events; their old timestamps cannot establish that scope.
  for (const [key, incident] of Object.entries(open)) {
    if (!key.startsWith(REFUSED_PREFIX) || key.includes(":") || incident.refusedModels) continue;
    const service = key.slice(REFUSED_PREFIX.length);
    incident.refusedModels = [...models.values()].filter(p => p.service === service).map(p => p.model);
  }
  const refused = new Map<string, { service: string; n: number; last: string; models?: Set<string> }>();
  for (const [modelKey, p] of models) {
    const legacyKey = `${REFUSED_PREFIX}${p.service}`;
    const legacy = open[legacyKey];
    const key = legacy?.refusedModels?.includes(p.model) ? legacyKey : modelKey;
    if (!open[key] && p.latest <= now - 3600_000) continue;
    const summary = refused.get(key) ?? { service: p.service, n: 0, last: p.last, models: new Set<string>() };
    summary.n += p.n;
    if (p.model === null) summary.models = undefined;
    else summary.models?.add(p.model);
    refused.set(key, summary);
  }
  for (const [key, p] of refused) {
    const service = p.service;
    const unused = p.models && !PROVIDERS[service]?.stops && !(await stepsOnService(service, p.models)).length;
    out.push({
      key,
      level: unused ? "later" : "today",
      ...(unused ? {} : { owner: true as const }),
      title: unused ? `${providerName(service)} 的旧模型限制尚未验证` : `${providerName(service)} 拒绝调用，需要核对账号或额度`,
      impact: unused ? "当前处理步骤未使用这些受限模型；旧限制仍未验证" : await providerStops(service, p.models),
      heals: "需先恢复访问，再确认失败任务已接续",
      action: `去${providerConsole(service)}看余额、套餐和消费上限，恢复访问后核实一次成功调用，并从后台接续失败任务；都正常的话，发起一次维护查原因`,
      detail: `${p.models ? `模型 ${[...p.models].join("、")}；` : ""}最近一次成功后被拒 ${p.n} 次，尚未取得后续成功调用：${p.last}`,
    });
  }
  const capped = await sql<{ service: string; per_day: number; used: number }[]>`
    SELECT b.service, b.per_day, count(a.id)::int AS used FROM budgets b
    JOIN receipt_attempts a ON a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day'
    WHERE b.per_day > 0 GROUP BY 1, 2 HAVING count(a.id) >= b.per_day`;
  for (const c of capped) {
    out.push({
      key: `budget.day.${c.service}`,
      level: "later",
      title: `${providerName(c.service)} 过去 24 小时的调用额度用完了`,
      impact: `${await providerStops(c.service)}，直到额度随时间腾出来`,
      heals: "会，额度按 24 小时滚动恢复",
      action: "这次不用处理；如果经常出现，再决定要不要调高额度",
      detail: `24 小时内 ${c.used} 次，上限 ${c.per_day}（budgets 表）`,
    });
  }
  return out;
}

interface AlertState {
  [key: string]: { title: string; since: string; sentAt?: string; agentOnly?: true; handedAt?: string; refusedModels?: (string | null)[] };
}

const DAILY_PREFIX = "report.daily:";
const dailyDate = (key: string) => key.startsWith(DAILY_PREFIX) && isValidDate(key.slice(DAILY_PREFIX.length))
  ? key.slice(DAILY_PREFIX.length) : undefined;
/** Missing dailies are looked for, and announced ones followed, over the last seven Beijing calendar days. */
const dailyScanFrom = (now: number) => addDays(beijingDate(now), -6);

async function alertState(): Promise<AlertState> {
  const [row] = await sql<{ value: AlertState }[]>`SELECT value FROM settings WHERE key = 'alerts.state'`;
  return { ...(row?.value ?? {}) };
}

/** When the owner was last told that a problem keeps coming back, by key, for the last day. */
async function returnsTold(now: number): Promise<Record<string, string>> {
  const [row] = await sql<{ value: Record<string, string> }[]>`SELECT value FROM settings WHERE key = 'alerts.returns'`;
  return Object.fromEntries(Object.entries(row?.value ?? {}).filter(([, at]) => now - Date.parse(at) < DAY_MS));
}

/** A handed-over incident the agent judged not a fault: until when and why. `since` ties it to that incident. */
export interface HeldAlert { since: string; until: string; reason: string; by: string; at: string }

async function savedHolds(): Promise<Record<string, HeldAlert>> {
  const [row] = await sql<{ value: Record<string, HeldAlert> }[]>`SELECT value FROM settings WHERE key = 'alerts.held'`;
  return row?.value ?? {};
}

/**
 * The agent looked at an incident it was handed and judged it not a fault (10-25: a quiet Saturday morning
 * escalated as "停止收录"): the owner is not told of that incident before `until`, a day at most. Past it, or
 * for a later incident, the handoff runs as before. Audited.
 */
export async function holdAlert(key: string, reason: string, until: Date, actor: string, now = Date.now()): Promise<HeldAlert> {
  if (!reason?.trim()) throw new Error("reason is required");
  if (!(until.getTime() > now && until.getTime() <= now + DAY_MS)) throw new Error("hold until a time within the next day");
  const open = (await alertState())[key];
  if (!open?.handedAt || open.sentAt) throw new Error(`not an open incident the agent has and the owner was not told of: ${key}`);
  const before = (await savedHolds())[key] ?? null;
  const held: HeldAlert = { since: open.since, until: until.toISOString(), reason: reason.trim(), by: actor, at: new Date(now).toISOString() };
  await sql.begin(async (tx) => {
    // Merged by key in the row itself, so holds written at the same time all stand; ended ones are dropped here.
    await tx`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.held', ${tx.json({ [key]: held } as never)}, ${actor})
             ON CONFLICT (key) DO UPDATE SET value = coalesce((SELECT jsonb_object_agg(k, v) FROM jsonb_each(settings.value) AS e(k, v)
               WHERE (v->>'until')::timestamptz > ${new Date(now)}), '{}'::jsonb) || EXCLUDED.value,
               updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "alert.hold", `alert:${key}`, held.reason, before, held, { db: tx });
  });
  return held;
}

async function dailyReportFindings(now: number, open: AlertState): Promise<Finding[]> {
  if (!collecting() || !modelsOn()) return [];
  const today = beijingDate(now);
  const [activity] = await sql<{ first_report: string | null; first_attempt: Date | null }[]>`
    SELECT (SELECT min(key) FROM reports WHERE kind = 'daily') AS first_report,
           (SELECT min(started_at) FROM job_runs WHERE job = 'reports.compose') AS first_attempt`;
  const starts = [activity?.first_report, activity?.first_attempt && beijingDate(activity.first_attempt)]
    .filter((date): date is string => !!date && isValidDate(date)).sort();
  const start = starts[0] ?? today;
  // New gaps and announced editions alike are followed for the scan window; settleDailies closes older ones.
  const from = dailyScanFrom(now);
  const dates = new Set(Object.keys(open).map(dailyDate).filter((date): date is string => !!date && date >= from));
  for (let date = from; date <= today; date = addDays(date, 1)) {
    if (date >= start) dates.add(date);
  }
  const overdue = [...dates].filter(date => now >= beijingAt(date, EDITION_TIMES.daily).getTime() + 2 * 3600_000).sort();
  if (!overdue.length) return [];
  const published = new Set((await sql<{ key: string }[]>`SELECT key FROM reports WHERE kind = 'daily' AND key IN ${sql(overdue)}`).map(r => r.key));
  return overdue.filter(date => !published.has(date)).map(date => ({
    key: `${DAILY_PREFIX}${date}`, level: "now",
    title: `${date} 的日报还没生成`, impact: `读者看不到 ${date} 的日报`,
    heals: "尚未补齐；需查看运行记录确认是否需要人工补做",
    action: "尽快发起一次维护处理",
    detail: `reports daily ${date} 不存在；看 reports.compose 的运行记录`,
  }));
}

/**
 * Announced editions this round did not find, because generation is paused or they fell out of the scan
 * window. Only an edition that exists has recovered (checkAlerts says so); one still missing stays open
 * quietly within the window, and past it is closed with one message instead of being reminded about forever.
 */
async function settleDailies(open: AlertState, found: Set<string>, now: number): Promise<{ missing: Set<string>; sent: string[] }> {
  const missing = new Set<string>();
  const sent: string[] = [];
  const dates = Object.keys(open).filter((key) => !found.has(key)).map(dailyDate).filter((date): date is string => !!date);
  if (!dates.length) return { missing, sent };
  const published = new Set((await sql<{ key: string }[]>`SELECT key FROM reports WHERE kind = 'daily' AND key IN ${sql(dates)}`).map((r) => r.key));
  for (const date of dates.filter((date) => !published.has(date))) {
    const key = `${DAILY_PREFIX}${date}`;
    if (date >= dailyScanFrom(now)) {
      missing.add(key);
      continue;
    }
    await sendAlert(`${date} 的日报没能补出，停止提醒`, [`读者看不到 ${date} 的日报；缺期从 ${beijingStamp(new Date(open[key]!.since))} 起，已超出七天的检查范围`]);
    sent.push(`${key}:expired`);
    delete open[key];
  }
  return { missing, sent };
}

/**
 * Every 10 minutes: new problems and recoveries of the now/today levels go out; follow-ups wait for 09:00.
 */
export async function checkAlerts(now = Date.now()) {
  const state = await alertState();
  const all = await collectFindings(now, state);
  const handing = agentConfigured() && !all.some((f) => f.key === "webhook.transport");
  const returns = await returnsTold(now);
  const holds = await savedHolds();
  const sent: string[] = [];
  for (const f of all) {
    const open = state[f.key];
    if (f.level === "later") {
      // Switching before the first check changes the impact, not whether access has recovered.
      if (f.key.startsWith(REFUSED_PREFIX) && !open) state[f.key] = { title: f.title, since: new Date(now).toISOString() };
      continue;
    }
    if (f.agentOnly || moduleAgentOnly(f.key)) {
      const since = open?.since ?? (f.since ?? new Date(now)).toISOString();
      state[f.key] = { title: f.title, since, agentOnly: true };
      continue;
    }
    if (handing && !f.owner && !open?.sentAt) {
      const handedAt = open?.handedAt ?? new Date(now).toISOString();
      const hold = holds[f.key];
      const held = !!hold && hold.since === open?.since && now < Date.parse(hold.until);
      if (held || now - Date.parse(handedAt) < HANDED_MS[f.level]) {
        // Before this round's handoff is published, the earlier ones of the day are counted.
        const earlier = open || returns[f.key] ? 0 : await handoffs(f.key, new Date(now - DAY_MS));
        if (earlier >= RETURNS - 1) {
          const msg = formatReturn(f, earlier + 1);
          await sendAlert(msg.title, msg.lines);
          returns[f.key] = new Date(now).toISOString();
          sent.push(`${f.key}:repeated`);
        }
        state[f.key] = { title: f.title, since: open?.since ?? (f.since ?? new Date(now)).toISOString(), handedAt };
        continue;
      }
    }
    if (open?.sentAt && now - Date.parse(open.sentAt) <= REPEAT_MS[f.level]) continue;
    const since = open ? new Date(open.since) : (f.since ?? new Date(now));
    // A problem the agent has had and not closed: the owner learns it is the agent's, and for how long.
    const shown = handing && !f.owner && open?.handedAt ? { ...f, heals: `AI 接手 ${duration(now - Date.parse(open.handedAt))} 还没解决`, action: "问问 AI 卡在哪了；需要你动手的它会说明" } : f;
    const msg = formatAlert(shown, since, now, !!open?.sentAt);
    await sendAlert(msg.title, msg.lines);
    state[f.key] = { ...open, title: f.title, since: since.toISOString(), sentAt: new Date(now).toISOString() };
    sent.push(f.key);
  }
  const found = new Set(all.map((f) => f.key));
  const dailies = await settleDailies(state, found, now);
  sent.push(...dailies.sent);
  for (const [key, open] of Object.entries(state)) {
    if (found.has(key) || dailies.missing.has(key)) continue;
    // An agent-only incident was never told to the owner, so clearing it stays quiet too. A module's
    // declaration covers a row saved before the flag existed, when this round no longer returns it.
    if (open.agentOnly || moduleAgentOnly(key) || !open.sentAt) {
      delete state[key];
      continue;
    }
    const [dropped] = key === "deliveries.failed" ? await sql`SELECT count(*)::int AS n FROM deliveries d
      WHERE d.status='failed' AND d.updated_at>${new Date(Date.parse(open.since)-86400_000)}
        AND EXISTS(SELECT 1 FROM audit_log a WHERE a.action='delivery.drop' AND a.subject='delivery:' || d.id AND a.created_at>=d.updated_at)` : [];
    const msg = formatRecovery(open.title, new Date(open.since), now);
    if (dropped?.n) await sendAlert(`已结束跟进：${open.title}`, [`${dropped.n} 条旧通知已决定不再补发，未确认送达`]);
    else await sendAlert(msg.title, msg.lines);
    sent.push(`${key}:${dropped?.n ? "closed" : "recovered"}`);
    delete state[key];
  }
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json(state as never)}, 'alerts')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.returns', ${sql.json(returns)}, 'alerts')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  // Revisit every open incident: a crash between saving the owner's alert and dispatching cannot lose it.
  // Transport receipts retain IDs across uncertain responses, independently from owner reminders.
  for (const f of all) if (f.level !== "later" && f.key !== "webhook.transport" && f.owner !== "only" && state[f.key]) {
    const agentOnly = f.agentOnly || moduleAgentOnly(f.key) ? { agentOnly: true as const } : {};
    await wakeAgent({ ...f, ...agentOnly, since: new Date(state[f.key]!.since) }, now);
  }
  await flushAgentEvents();
  return { open: Object.keys(state), sent };
}

/**
 * What a closure covers. "observed": the failures seen by its time (a fix whose old failures still sit in
 * the window): any new one reopens it, as on 10-17 when HN detail failures went on after "fixed". "ongoing":
 * the condition itself, judged acceptable (an upstream that fails a few times a day and recovers, dates
 * missing by rule): it holds through new failures for a week, then the condition is listed and judged again.
 * A source that stops working is another follow-up (`sources.failing.*`), never covered by either.
 */
export type ClosureScope = "observed" | "ongoing";
const ONGOING_CLOSURE_MS = 7 * 86_400_000;

/** A follow-up someone judged not worth fixing: who, when and why; `until` ends an ongoing closure. */
export interface DismissedFollowUp { title: string; reason: string; by: string; at: string; until?: string }

/** The follow-ups closed as not to be fixed, by key. */
async function savedDismissals(): Promise<Record<string, DismissedFollowUp>> {
  const [row] = await sql<{ value: Record<string, DismissedFollowUp> }[]>`SELECT value FROM settings WHERE key = 'alerts.dismissed'`;
  return row?.value ?? {};
}

/** The closures still covering a current follow-up (ClosureScope). */
export async function dismissedFollowUps(findings?: Finding[], now = Date.now()): Promise<Record<string, DismissedFollowUp>> {
  const current = findings ?? await sourceFollowUps(now);
  return Object.fromEntries(Object.entries(await savedDismissals()).filter(([key, closed]) => {
    const finding = current.find(f => f.key === key);
    if (!finding) return false;
    if (closed.until) return now < Date.parse(closed.until);
    return !finding.observedAt || finding.observedAt.getTime() <= Date.parse(closed.at);
  }));
}

/**
 * Closes a current source follow-up as not to be fixed, with the reason (audited): the digest stops listing
 * it. Only these name one source and one problem; a follow-up that counts many records would hide records
 * that arrive later. `scope` says what it covers (ClosureScope); disappearance also lapses the closure.
 */
export async function dismissFollowUp(key: string, reason: string, actor: string, now = Date.now(), scope: ClosureScope = "observed"): Promise<DismissedFollowUp> {
  if (!reason?.trim()) throw new Error("reason is required");
  const finding = (await sourceFollowUps(now)).find((f) => f.key === key);
  if (!finding) throw new Error(`not a current source follow-up: ${key}`);
  const before = (await savedDismissals())[key] ?? null;
  const dismissed: DismissedFollowUp = { title: finding.title, reason: reason.trim(), by: actor, at: new Date(now).toISOString(),
    ...(scope === "ongoing" ? { until: new Date(now + ONGOING_CLOSURE_MS).toISOString() } : {}) };
  await sql.begin(async (tx) => {
    await tx`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.dismissed', ${tx.json({ [key]: dismissed } as never)}, ${actor})
             ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "followup.dismiss", `followup:${key}`, dismissed.reason, before, dismissed, { db: tx });
  });
  return dismissed;
}

/** Undoes a closure (audited): the digest lists the follow-up again while it lasts. Null when it is not closed. */
export async function restoreFollowUp(key: string, reason: string, actor: string): Promise<DismissedFollowUp | null> {
  if (!reason?.trim()) throw new Error("reason is required");
  const before = (await savedDismissals())[key];
  if (!before) return null;
  await sql.begin(async (tx) => {
    await tx`UPDATE settings SET value = value - ${key}::text, updated_by = ${actor}, updated_at = now() WHERE key = 'alerts.dismissed'`;
    await audit(actor, "followup.restore", `followup:${key}`, reason.trim(), before, null, { db: tx });
  });
  return before;
}

/** 09:00: the open follow-ups, one list; nothing when there are none. Closures whose problem is gone lapse here.
 *  Agent-only handoffs stay on the ops list and are not part of the owner's message. */
export async function sendDigest(now = Date.now()) {
  const found = (await collectFindings(now)).filter((f) => f.level === "later");
  const dismissed = await dismissedFollowUps(found, now);
  const lapsed = Object.keys(await savedDismissals()).filter((key) => !dismissed[key]);
  if (lapsed.length) await sql`UPDATE settings SET value = value - ${sql.array(lapsed)}::text[], updated_at = now() WHERE key = 'alerts.dismissed'`;
  const items = found.filter((f) => !dismissed[f.key] && !f.agentOnly);
  const lines = items.map((f, i) => `${i + 1}. ${f.title}${f.detail ? `\n   ${f.detail}` : ""}`);
  // Once the hub has the list, the agent works through it alone and passes on what is still the owner's. Without
  // an agent, or when the list did not get through, the owner gets it as before.
  const taken = found.some(f => !dismissed[f.key]) && await wakeDigest(beijingDate(now), lines.length || found.length);
  const toldOwner = lines.length > 0 && !taken;
  if (toldOwner) await sendAlert(`📋 系统日报 · ${beijingDay(now)}`, ["以下事项需要跟进，具体影响见各条说明；可把整条转给 AI 处理。", ...lines]);
  await flushAgentEvents();
  return { items: lines.length, toldOwner };
}
