// Operations alerts. The person reading them is the site owner, not an engineer: each
// message says what readers see, whether it heals by itself and what, if anything, the owner must do.
//   now   — readers are affected and it has not healed: sent at once, repeated hourly, recovery reported.
//   today — money at risk or only the owner can act: sent at once, repeated at most daily, recovery reported.
//   later — other follow-ups: one 09:00 message a day, meant to be handed to the AI.
// A site's responder (modules.ts) filters findings for the owner, preserving repeat and recovery
// tracking for messages it returns and replacing the default digest policy.
// Delivery goes through sendAlert (ops chat, internal-chat fallback; off unless FEISHU_INTERNAL_ENABLED).
import { beijingAt, beijingDate } from "@aihot/contracts/time";
import { ALERTS, EDITION_TIMES } from "@aihot/site";
import { sql } from "../db.ts";
import { beijingDay, beijingStamp, duration, formatAlert, formatRecovery, sendAlert, type Finding, type Level } from "../notify/feishu.ts";
import { stepsOnService } from "../editorial/models.ts";
import { backupConfigured } from "./backup.ts";
import { GROUPING_WARN_AFTER_MS, waitingSelectedNews } from "./grouping.ts";
import { upstreamFindings } from "../media/upstream.ts";
import { responder, serverModules } from "../modules.ts";
import { sourceHealth, sourceHealthList } from "../sources/health.ts";

const REPEAT_MS: Record<Exclude<Level, "later">, number> = { now: 3600_000, today: 24 * 3600_000 };

// Valves default off: read at call time, only an explicit "true" turns them on.
const collecting = () => process.env.COLLECT_ENABLED === "true";
const modelsOn = () => process.env.MODEL_CALLS_ENABLED === "true";
/**
 * How long the site may go without a new article before it counts as stalled (ALERT_QUIET_MINUTES, else
 * the site's own setting; small source lists are quieter). At most a day: the check looks one day back.
 */
const QUIET_MINUTES = Math.min(Number(process.env.ALERT_QUIET_MINUTES || ALERTS.quietMinutes), 1440);

/** Everything wrong right now, with its level. */
export async function collectFindings(now = Date.now()): Promise<Finding[]> {
  const out: Finding[] = [];

  // Readers affected now
  // Content flow, judged by outcome: whatever broke (worker, egress proxy, models, queues), readers see
  // a site that stops changing. Skipped for 20 minutes after the worker starts, and where the valves are off.
  const [hb] = await sql<{ value: { startedAt?: string } }[]>`SELECT value FROM settings WHERE key = 'heartbeat.worker'`;
  const settled = !hb?.value.startedAt || now - Date.parse(hb.value.startedAt) > 20 * 60_000;
  if (settled && collecting()) {
    const [last] = await sql<{ at: Date | null }[]>`SELECT max(a.discovered_at) AS at FROM articles a
      JOIN sources s ON s.id = a.source_id WHERE s.participation_mode = 'editorial' AND a.discovered_at > now() - interval '1 day'`;
    if (!last?.at || now - last.at.getTime() > QUIET_MINUTES * 60_000) {
      // A site without an enabled source has nothing to collect.
      const [anySource] = await sql`SELECT 1 FROM sources WHERE enabled AND participation_mode = 'editorial' LIMIT 1`;
      if (anySource) {
        out.push({
          key: "content.collect",
          level: "now",
          title: "网站停止收录新文章",
          impact: last?.at ? `读者看不到新文章：最后一篇收录于 ${beijingStamp(last.at)}` : "读者看不到新文章：一天内没有收录任何文章",
          heals: ALERTS.usualFlow ? `没有，${ALERTS.usualFlow}` : "没有",
          action: "尽快发起一次维护处理",
          detail: `editorial articles.discovered_at 超过 ${QUIET_MINUTES} 分钟没有新值（热度信号单独评估）；查 sources.schedule、出网代理与采集失败`,
          since: last?.at ?? undefined,
        });
      }
    }
  }
  if (settled && collecting() && modelsOn()) {
    const waiting = (await waitingSelectedNews()).filter((item) => now - item.since.getTime() >= GROUPING_WARN_AFTER_MS);
    if (waiting.length) {
      const manual = waiting.filter((item) => item.recovery === "manual").length;
      const receipt = waiting.some((item) => item.recovery === "receipt");
      out.push({
        key: "content.grouping",
        level: "now",
        title: "有精选新闻卡在去重确认，暂未发布",
        impact: `${waiting.length} 条已达到精选条件的新闻等待确认超过 10 分钟，还没进入精选，读者可能晚看到这些更新`,
        heals: manual ? `${manual} 条需要人工处理后才能恢复${manual < waiting.length ? "；其余仍在自动恢复" : ""}`
          : receipt ? "仍在等待自动恢复；付费结果未知的请求会在 30 分钟后自动放行一次" : "还会自动重试，但等待已经超过正常范围",
        action: manual ? "转给 AI 处理；结果未知的付费请求需先核对计费与结果，再决定是否放行" : "转给 AI 检查等待原因，避免继续积压",
        detail: waiting.slice(0, 8).map((item) => `${item.articleId}（${duration(now - item.since.getTime())}）${item.receiptId ? ` 回执 #${item.receiptId}` : ""}${item.error ? `：${item.error.slice(0, 120)}` : ""}`).join("；"),
        since: waiting[0]!.since,
      });
    }
    const [p] = await sql<{ waiting: number; oldest: Date | null; failed: number }[]>`
      SELECT count(*) FILTER (WHERE processing_state = 'new' AND discovered_at < now() - interval '2 hours')::int AS waiting,
             min(discovered_at) FILTER (WHERE processing_state = 'new') AS oldest,
             count(*) FILTER (WHERE processing_state = 'failed' AND discovered_at > now() - interval '3 hours')::int AS failed
      FROM articles WHERE processing_state IN ('new', 'failed') AND discovered_at > now() - interval '2 days'`;
    if (p!.waiting >= 10 || p!.failed >= 20) {
      const errors = await sql<{ error: string; n: number }[]>`
        SELECT left(coalesce(processing_error, '（无）'), 120) AS error, count(*)::int AS n FROM articles
        WHERE processing_state IN ('new', 'failed') AND discovered_at > now() - interval '3 hours' AND processing_error IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 3`;
      out.push({
        key: "content.process",
        level: "now",
        title: "新内容卡住了，进不了网站",
        impact: [p!.waiting >= 10 && `${p!.waiting} 篇新文章等了 2 小时以上还没处理完`, p!.failed >= 20 && `最近 3 小时 ${p!.failed} 篇新文章处理失败`]
          .filter(Boolean)
          .join("；") + "，精选和热点会缺内容",
        heals: p!.waiting >= 10 ? "服务恢复后会自动补处理" : "不会，需要修好后重新处理这些文章",
        action: "转给 AI 处理",
        detail: errors.map((e) => `${e.error}（${e.n}）`).join("；") || "没有记录错误",
        since: p!.waiting >= 10 && p!.oldest ? p!.oldest : undefined,
      });
    }
    // The daily report is composed from its edition time, and tried again every half hour until it exists:
    // two hours later it is overdue.
    if (now >= beijingAt(beijingDate(now), EDITION_TIMES.daily).getTime() + 2 * 3600_000) {
      const [r] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${beijingDate(now)}`;
      if (!r) {
        out.push({
          key: "report.daily",
          level: "now",
          title: "今天的日报还没生成",
          impact: "读者看不到今天的日报",
          heals: "系统每半小时补做一次，到现在还没成功",
          action: "尽快发起一次维护处理",
          detail: `reports daily ${beijingDate(now)} 不存在；看 reports.compose 的运行记录`,
        });
      }
    }
  }

  // Money, and things only the owner can do
  out.push(...(await providerFindings()));

  // Content-group pushes the Feishu webhook refused (a removed bot, a changed address); nothing resends them.
  const [refused] = await sql<{ n: number; target: string | null; response: string | null }[]>`
    SELECT count(*)::int AS n, max(t.note) AS target, left(max(d.response), 200) AS response FROM deliveries d JOIN notify_targets t ON t.key = d.target_key
    WHERE d.status = 'failed' AND d.updated_at > now() - interval '1 day'`;
  if (refused!.n > 0) {
    out.push({
      key: "deliveries.failed",
      level: "today",
      title: "飞书内容群有推送没发出去",
      impact: `过去 24 小时 ${refused!.n} 条通知没进${refused!.target ?? "内容群"}`,
      heals: "不会自动重发",
      action: "转给 AI 处理；如果推送机器人被移出了群，需要你把它加回去",
      detail: refused!.response ?? "",
    });
  }

  if (backupConfigured()) {
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
      out.push({
        key: "backup.failed",
        level: "today",
        title: "数据库备份连续两天没成功",
        impact: lastOk ? `万一服务器出事，最近 ${duration(age)} 的数据可能无法完整恢复` : "还没有成功的完整备份，服务器出事时可能无法恢复数据",
        heals: "不会",
        action: "转给 AI 处理",
        detail: `${lastOk ? "最近一次成功" : "首次备份尝试"} ${beijingStamp(since)}${state ? `；${state}` : ""}；看 ops.backup 的运行记录`,
        since: new Date(since),
      });
    } else if (!b || !b.value.uploaded || age > 30 * 3600_000) {
      out.push({ key: "backup.stale", level: "later", title: "数据库备份超过一天没成功", detail: b ? `最近一次 ${beijingStamp(b.value.at)}${state ? `（${state}）` : ""}；看 ops.backup` : "还没有成功的备份记录" });
    }
  }

  out.push(...(await upstreamFindings(now)));

  // What the site's modules find.
  for (const m of serverModules()) if (m.alerts) out.push(...(await m.alerts(now)));

  // Follow-ups
  if (collecting()) {
    for (const group of await sourceHealth(now)) {
      if (group.failing.length) out.push({
        key: `sources.failing.${group.mode}`, level: "later", title: `${group.name}有 ${group.failing.length} 个信源连续抓取失败`,
        detail: sourceHealthList(group.failing, s => `连续失败 ${s.fail_count} 次${s.last_error ? `，${s.last_error}` : ""}`) + "；转给 AI 检查抓取错误",
      });
      if (group.unstable.length) out.push({
        key: `sources.unstable.${group.mode}`, level: "later", title: `${group.name}有 ${group.unstable.length} 个信源反复抓取失败`,
        detail: sourceHealthList(group.unstable, s => `近 7 天失败 ${s.failed}/${s.runs} 次`) + "；即使最近成功也需检查，避免继续漏收",
      });
      if (group.silent.length) out.push({
        key: `sources.silent.${group.mode}`, level: "later", title: `${group.name}有 ${group.silent.length} 个信源 7 天未发现新内容`,
        detail: sourceHealthList(group.silent, s => `近 7 天 ${s.runs} 次抓取、0 条新发现`) + "；需对照原站，区分低频更新与采集失效",
      });
      if (group.quality.length) out.push({
        key: `sources.quality.${group.mode}`, level: "later", title: `${group.name}有 ${group.quality.length} 个信源需要核实文章质量`,
        detail: sourceHealthList(group.quality, s => `近 7 天缺发布时间 ${s.undated} 篇、反复修订 ${s.repeated} 篇`) + "；缺时间可能让新闻按历史文章处理，反复修订需核对正文是否混入变化内容",
      });
      if (group.detailFailures.length) out.push({
        key: `sources.details.${group.mode}`, level: "later", title: `${group.name}有 ${group.detailFailures.length} 个信源详情补全失败`,
        detail: sourceHealthList(group.detailFailures, s => `近 7 天 ${s.detail_failures} 次`) + "；查看抓取记录中的详情地址与错误",
      });
    }
  }
  const [r] = await sql<{ receipts: number; services: string | null; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE status = 'unknown') AS receipts,
           (SELECT string_agg(DISTINCT service || '/' || purpose, '、') FROM receipts WHERE status = 'unknown') AS services,
           (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS deliveries`;
  if (r!.receipts > 0) {
    out.push({ key: "receipts.unknown", level: "later", title: `${r!.receipts} 个付费请求的结果尚未确认`, detail: `${r!.services}；可能影响内容处理，后台“运行”页查看影响；自动恢复后仍未知的请求需核对后放行` });
  }
  if (r!.deliveries > 0) out.push({ key: "deliveries.unknown", level: "later", title: `${r!.deliveries} 条飞书内容群推送不确定是否送达`, detail: "后台“运行”页核对群里有没有，再标记或重发" });

  // Runnable jobs (deferred ones excluded) that have waited more than two hours.
  const queues = await sql<{ name: string; n: number; oldest: Date }[]>`
    SELECT name, count(*)::int AS n, min(start_after) AS oldest FROM pgboss.job
    WHERE state IN ('created', 'retry') AND start_after <= now() AND name NOT LIKE 'cron.%' GROUP BY 1`;
  for (const q of queues) {
    if (now - q.oldest.getTime() > 2 * 3600_000) {
      out.push({ key: `queue.${q.name}`, level: "later", title: `后台任务排队超过 2 小时：${q.name}`, detail: `${q.n} 个等待，最早的等了 ${duration(now - q.oldest.getTime())}` });
    }
  }

  // The site's modules' follow-ups.
  for (const m of serverModules()) if (m.followUps) out.push(...(await m.followUps(now)));
  return out;
}

/** What stops when a model service refuses us: the steps that default to its models, else a pointer to the admin. */
function modelStops(service: string): string {
  const steps = stepsOnService(service);
  return steps.length ? `${steps.join("、")}停了` : "用到这家模型的步骤停了（看后台“模型与评测”），新内容可能进不了精选";
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
export const providerStops = (service: string) => {
  const p = PROVIDERS[service];
  return p ? (p.stops ?? modelStops(service)) : "相关功能停了";
};
export const providerConsole = (service: string) => PROVIDERS[service]?.where ?? `${service} 后台`;

/** Paid services that refuse us (no balance, a dead key), and daily budgets used up. */
async function providerFindings(): Promise<Finding[]> {
  const out: Finding[] = [];
  const refused = await sql<{ service: string; n: number; last: string }[]>`
    SELECT service, count(*)::int AS n, (array_agg(left(error, 200) ORDER BY started_at DESC))[1] AS last FROM receipt_attempts
    WHERE status = 'failed' AND started_at > now() - interval '1 hour'
      AND error ~* '(HTTP 40[123]\\M|insufficient|balance|arrear|good standing|欠费|余额)'
    GROUP BY 1 HAVING count(*) >= 3`;
  for (const p of refused) {
    out.push({
      key: `provider.refused.${p.service}`,
      level: "today",
      owner: true,
      title: `${providerName(p.service)} 拒绝服务，可能欠费或账号失效`,
      impact: providerStops(p.service),
      heals: "不会",
      action: `去${providerConsole(p.service)}看余额和账号状态，充值或恢复后系统会自动继续；两样都正常的话，发起一次维护查原因`,
      detail: `最近 1 小时被拒 ${p.n} 次：${p.last}`,
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
      impact: `${providerStops(c.service)}，直到额度随时间腾出来`,
      heals: "会，额度按 24 小时滚动恢复",
      action: "这次不用处理；如果经常出现，再决定要不要调高额度",
      detail: `24 小时内 ${c.used} 次，上限 ${c.per_day}（budgets 表）`,
    });
  }
  return out;
}

interface AlertState {
  [key: string]: { title: string; since: string; sentAt: string };
}

/**
 * Every 10 minutes: new problems and recoveries of the now/today levels go out; follow-ups wait for 09:00.
 * With a responder, only what it hands back goes out, and what it still holds is not reported as recovered.
 */
export async function checkAlerts(now = Date.now()) {
  const all = await collectFindings(now);
  const r = responder();
  const { tell, held } = r ? await r.take(all, now) : { tell: all, held: [] as string[] };
  const found = tell.filter((f) => f.level !== "later");
  const [row] = await sql<{ value: AlertState }[]>`SELECT value FROM settings WHERE key = 'alerts.state'`;
  const state: AlertState = { ...(row?.value ?? {}) };
  const sent: string[] = [];
  for (const f of found) {
    const open = state[f.key];
    if (open && now - Date.parse(open.sentAt) <= REPEAT_MS[f.level as Exclude<Level, "later">]) continue;
    const since = open ? new Date(open.since) : (f.since ?? new Date(now));
    const msg = formatAlert(f, since, now, !!open);
    await sendAlert(msg.title, msg.lines);
    state[f.key] = { title: f.title, since: since.toISOString(), sentAt: new Date(now).toISOString() };
    sent.push(f.key);
  }
  for (const [key, open] of Object.entries(state)) {
    if (found.some((f) => f.key === key) || held.includes(key)) continue;
    const msg = formatRecovery(open.title, new Date(open.since), now);
    await sendAlert(msg.title, msg.lines);
    sent.push(`${key}:recovered`);
    delete state[key];
  }
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json(state as never)}, 'alerts')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return { open: Object.keys(state), sent };
}

/** 09:00 (without a responder): one message with the follow-ups; nothing when there are none. */
export async function sendDigest(now = Date.now()) {
  const items = (await collectFindings(now)).filter((f) => f.level === "later");
  const lines = items.map((f, i) => `${i + 1}. ${f.title}${f.detail ? `\n   ${f.detail}` : ""}`);
  if (!lines.length) return { items: 0 };
  await sendAlert(`📋 系统日报 · ${beijingDay(now)}`, ["以下事项需要跟进，具体影响见各条说明；可把整条转给 AI 处理。", ...lines]);
  return { items: lines.length };
}
