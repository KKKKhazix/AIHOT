// WeChat push through the DSH-IM plugin (xmanrui/dsh-im), channel "weixin".
//
// Two schedules, each composing a text message and POSTing it to the plugin's proactive-delivery
// endpoint, which relays it to WeChat over the bound bot's connection. No model calls, no receipts:
// this module only reads the site's own tables.
//
//   1. daily (08:30 Beijing): the daily report and the hot ranking in one message.
//   2. the weekly GitHub rank: the newest edition the github-rank module stored, top 10 by rank,
//      pushed once per edition however the engine judged those items. That ranking is already a
//      filtered list of the week's fastest-growing projects, so the site's own scoring must not
//      decide whether readers hear about it: most of its items are BLOCKed by the prefilter or score
//      below the T2 threshold, and none would ever reach the selected-item push (T1/T1_5 only).
//
// The plugin's URL is a loopback address, so this uses plain fetch rather than the backend's
// guardedFetch: the SSRF guard blocks private addresses and ALLOW_PRIVATE_NETWORK_FETCH is refused
// at startup in production (config.ts assertProductionSecrets). notify/feishu.ts reaches the
// site's own addresses the same way.
//
// Delivering needs a saved target in the plugin (Settings -> IM bots -> the bot -> New target);
// a targetId is a stable alias that survives later route edits, which is why only it, not a
// platform user id, is configured here.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sql } from "@aihot/backend/db";
import { defineServerModule, type Scheduled } from "@aihot/backend/modules";
import { beijingDate } from "@aihot/contracts/time";
import { describeProject, RANK_DESCRIPTION_STEP } from "./description.ts";
import { composeWeeklyRank, type RankEdition, type RankedProject } from "./message.ts";

const PUSH_URL = process.env.WECHAT_PUSH_URL ?? "";
const BOT_ID = process.env.WECHAT_PUSH_BOT_ID ?? "";
const TARGET_ID = process.env.WECHAT_PUSH_TARGET_ID ?? "";

/** A push needs all three; a missing one leaves the schedule out and the worker logs nothing. */
const configured = () => PUSH_URL.length > 0 && BOT_ID.length > 0 && TARGET_ID.length > 0;

/**
 * The source the GitHub ranking lives under (industry/sources.json). Its items are read from
 * `articles`, not `publications`: the push names the ten fastest-growing projects whether or not the
 * engine selected them, which is the point of this schedule.
 */
const RANK_SOURCE_ID = "github-rank";
/** The projects one push lists. */
const RANK_LIMIT = 10;

const schedule: Scheduled = {
  name: "wechat-push.daily",
  // Every 10 minutes through 08:30-09:59, not once at 08:30: reports.compose is a separate job that
  // runs on the half hour, so a failed 08:00 composition would otherwise mean no briefing at all.
  // A run before 08:30, without today's report, or after today's push already succeeded sends nothing.
  // 2026-11-16（方案 A）：每 2 分钟一次、窗口放到 07:50–10:59 —— 日报一生成，下一次 tick 就推；
  // 失败也在 2 分钟内重试，不再像以前要等到 09:00 才送达。
  cron: "*/2 7-11 * * *",
  missed: "once",
  run: () => pushDaily(),
  when: configured,
};

/**
 * The weekly ranking's check, daily at 09:00 rather than only on Monday. Upstream publishes an edition
 * each Monday but is sometimes late, and only the per-edition guard below stops a second send; checking
 * every day therefore sends each edition once, as soon as it has been stored, and stays silent the rest
 * of the week. Runs are 10 minutes apart so a failed POST is retried inside the hour (the cron queue's
 * own retry), and a missed slot is replayed once after a restart, which the guard still bounds.
 */
const rankSchedule: Scheduled = {
  name: "wechat-push.rank",
  cron: "*/10 9 * * *",
  missed: "once",
  run: () => pushWeeklyRank(),
  when: configured,
};

interface DailyItem {
  title: string;
  summary?: string | null;
  sourceName?: string | null;
  score?: number | null;
}

interface DailyReport {
  date: string;
  lead: { title: string; leadParagraph: string };
  flashes: Array<{ title: string }>;
  metrics?: { totalEvents?: number; sourcesCount?: number };
  sections: Array<{ label?: string | null; items: DailyItem[] }>;
}

interface HotEntry {
  rank: number;
  title: string;
  heat: number;
  trend: string;
  sourceNames: string[];
}

/** One push, as recorded in job_runs. `edition` is set by the rank push: the guard reads it back. */
interface PushResult {
  sent: boolean;
  reason?: string;
  chars?: number;
  edition?: string;
  /** The rank push's projects the model described; the rest went out with their line and address alone. */
  described?: number;
}

async function pushDaily(now = new Date()): Promise<PushResult> {
  if (!configured()) return { sent: false, reason: "push is not configured" };

  const today = beijingDate(now);
  // The window is 08:30-10:00; the cron also fires at 08:00-08:20, before the briefing is due, and a
  // restart can replay the missed slot hours later. Outside the window nothing is sent: a morning
  // briefing is not worth delivering at night.
  const windowStart = new Date(Date.parse(`${today}T08:30:00+08:00`));
  const windowEnd = new Date(Date.parse(`${today}T10:00:00+08:00`));
  if (now.getTime() < windowStart.getTime()) return { sent: false, reason: "before 08:30" };
  if (now.getTime() >= windowEnd.getTime()) return { sent: false, reason: "past the 10:00 window" };

  // Today's briefing goes out once. This window's earlier runs recorded their outcome in job_runs
  // (recordRun), so a successful {sent:true} today means stop; a failed or skipped one is retried.
  const [already] = await sql<Array<{ id: number }>>`
    SELECT id FROM job_runs
    WHERE job = 'wechat-push.daily' AND status = 'ok' AND detail->>'sent' = 'true'
      AND started_at >= ${windowStart.toISOString()}::timestamptz
    LIMIT 1`;
  if (already) return { sent: false, reason: "already pushed today" };

  // `key` is the report's own day (window_start is the day before: the window runs 08:00 to 08:00).
  const [report] = await sql<Array<{ content: unknown; date: string }>>`
    SELECT content, key AS date FROM reports
    WHERE kind = 'daily' ORDER BY generated_at DESC LIMIT 1`;
  if (!report) return { sent: false, reason: "no daily report yet" };

  // reports.compose runs on the half hour, so at 08:30 today's briefing may not exist yet. Sending
  // the newest report regardless would deliver yesterday's news as today's; a later run this window
  // picks today's up once it is composed.
  if (report.date !== today) {
    return { sent: false, reason: `today's report (${today}) is not composed yet; newest is ${report.date}` };
  }

  const daily = (typeof report.content === "string" ? JSON.parse(report.content) : report.content) as DailyReport;

  const [hot] = await sql<Array<{ entries: unknown }>>`
    SELECT entries FROM hot_rankings ORDER BY computed_at DESC LIMIT 1`;
  const allHot = hot ? ((typeof hot.entries === "string" ? JSON.parse(hot.entries) : hot.entries) as HotEntry[]) : [];

  const text = composeText(daily, allHot.slice(0, 5));

  await sendText(text);
  return { sent: true, chars: text.length };
}

/**
 * One message to the bound target. The plugin's own codes (unknown-target, bot-not-connected, ...) say
 * what the owner must fix, so they are kept in the error the run records.
 */
async function sendText(text: string): Promise<void> {
  // Direct mode: use the SuperAgent WeChat binding (the same bot the operator already talks to),
  // instead of the DSH-IM delivery endpoint. This removes the dependency on dsh-im's host auth.
  if (process.env.WECHAT_PUSH_DIRECT === "1") {
    // 【2026-11-11 修复】不能直接用 homedir()：AIHOT 的 HOME 被设在工作区的
    // .tools/home（/home/tank543 对服务是只读的），拼出来指向一个不存在的路径。
    // 优先级：WECHAT_PUSH_BINDING（显式） → $DSH_HOME/state/... → ~/.dsh/state/...
    const bindingPath = process.env.WECHAT_PUSH_BINDING
      || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "state", "superagent", "weixin-binding.json");
    const binding = JSON.parse(await readFile(bindingPath, "utf8")) as { baseUrl: string; token: string; accountId: string };
    const endpoint = binding.baseUrl.replace(/\/$/, "") + "/ilink/bot/sendmessage";
    const bodyJson = JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: binding.accountId,
        client_id: `aihot-wechat-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
      },
    });
    // 2026-11-16：早上 08:30–08:50 连续三次 `ret:-2 prepare failed`、09:00 又成功 —— 属于瞬时抖动。
    // 这里对「非 0 ret / 无 message_id」做 3 次退避重试，避免一次抖动就丢掉当天的早报。
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 2000 : 6000));
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${binding.token}`,
        },
        body: bodyJson,
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => null)) as { message_id?: string; ret?: number; errcode?: number } | null;
      const code = body?.errcode ?? body?.ret;
      if (res.ok && body?.message_id && (code === undefined || code === 0)) return;
      lastErr = body ? JSON.stringify(body).slice(0, 200) : `http-${res.status}`;
      // 只有瞬时类错误（ret:-2 / prepare failed / 5xx）值得重试；其它立即抛出。
      const transient = !res.ok || code === -2 || /prepare failed/.test(lastErr);
      if (!transient) break;
    }
    throw new Error(`wechat direct failed: ${lastErr}`);
  }
  const res = await fetch(PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId: BOT_ID, targetId: TARGET_ID, text, format: "plain" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as { sent?: boolean; error?: { code?: string } } | null;
  if (!res.ok || body?.sent !== true) throw new Error(`wechat push failed: ${body?.error?.code ?? `http-${res.status}`}`);
}

interface RankRow {
  rank: number;
  repo: string | null;
  title: string;
  edition: RankEdition | null;
  body_text: string | null;
  /** The edition's file inside the upstream repository, the identity a push is recorded against. */
  file: string | null;
}

/**
 * The project's own one-line description as github-rank's projectBody() printed it. Upstream's text is
 * English and cut to one line, but it is the only description the edition carries, and the model only
 * needs it to say what the project is.
 */
function descriptionFromBody(bodyText: string | null): string | null {
  return /^- 项目简介：(.*)$/m.exec(bodyText ?? "")?.[1]?.trim() || null;
}

/**
 * One weekly push: the newest edition github-rank stored, top 10 by rank. Reads `articles` (with the
 * module's own payload) rather than `publications`, so the ten fastest-growing projects go out whether
 * the engine selected them or not.
 *
 * The newest edition is the one with the greatest `published_at`; every project of an edition shares
 * the Monday upstream committed it. Ties cannot cross editions, because each edition has its own date.
 */
async function pushWeeklyRank(): Promise<PushResult> {
  if (!configured()) return { sent: false, reason: "push is not configured" };

  const rows = await sql<RankRow[]>`
    SELECT (a.raw->>'rank')::int AS rank, a.raw->>'repo' AS repo, a.title, a.raw->'edition' AS edition,
           a.body_text, split_part(a.raw->>'externalId', '#', 1) AS file
    FROM articles a
    WHERE a.source_id = ${RANK_SOURCE_ID} AND a.raw ? 'rank'
      AND a.published_at = (SELECT max(published_at) FROM articles WHERE source_id = ${RANK_SOURCE_ID} AND raw ? 'rank')
    ORDER BY (a.raw->>'rank')::int
    LIMIT ${RANK_LIMIT}`;
  if (rows.length === 0) return { sent: false, reason: "no edition stored yet" };

  const edition = rows[0]!.file ?? "";
  // Each edition goes out once. The guard is the edition itself, not a weekday: an edition upstream
  // published late is still sent by the next daily check, and re-running this job sends nothing.
  const [already] = await sql<Array<{ id: number }>>`
    SELECT id FROM job_runs
    WHERE job = 'wechat-push.rank' AND status = 'ok' AND detail->>'sent' = 'true' AND detail->>'edition' = ${edition}
    LIMIT 1`;
  if (already) return { sent: false, reason: `edition ${edition} already pushed`, edition };

  const items: RankedProject[] = [];
  let described = 0;
  for (const row of rows) {
    const source = descriptionFromBody(row.body_text);
    // One project's description failing (an outage, unusable output) must not hold up the ranking: the
    // push is the point of the schedule, and a later run reuses the answers already paid for.
    const description = row.repo
      ? await describeProject({ repo: row.repo, description: source }).catch(() => null)
      : null;
    if (description) described += 1;
    items.push({ rank: row.rank, repo: row.repo, title: row.title, description });
  }

  const text = composeWeeklyRank(rows[0]!.edition, items);
  await sendText(text);
  return { sent: true, chars: text.length, edition, described };
}

function composeText(daily: DailyReport, hot: HotEntry[]): string {
  const lines: string[] = [];
  const leadTitle = daily.lead?.title ?? "";
  lines.push(`【AIHOT 热点早报 ${daily.date}】`);
  lines.push("");

  if (leadTitle) {
    lines.push(`📌 ${leadTitle}`);
    if (daily.lead.leadParagraph) lines.push(daily.lead.leadParagraph);
  }

  // The lead is normally the top-scoring item of its own section, so it is skipped here to avoid
  // printing the same story twice; every other item is listed once, under its section label.
  let shown = 0;
  for (const section of daily.sections) {
    const items = section.items.filter((item) => item.title !== leadTitle);
    if (items.length === 0) continue;
    lines.push("");
    if (section.label) lines.push(`【${section.label}】`);
    for (const item of items) {
      lines.push(`• ${item.title}${item.sourceName ? `（${item.sourceName}）` : ""}`);
      shown += 1;
    }
  }
  if (shown === 0 && !leadTitle) lines.push("今天没有需要关注的新动态。");

  if (daily.flashes?.length) {
    lines.push("");
    lines.push("快讯：");
    for (const flash of daily.flashes) lines.push(`· ${flash.title}`);
  }

  if (hot.length > 0) {
    lines.push("");
    lines.push("🔥 当前热点：");
    for (const entry of hot) {
      const arrow = entry.trend === "up" ? " ↑" : entry.trend === "down" ? " ↓" : "";
      lines.push(`${entry.rank}. ${entry.title}${arrow}（${entry.sourceNames.length} 家信源）`);
    }
  }

  const metrics = daily.metrics;
  if (metrics) {
    lines.push("");
    lines.push(`今日共 ${metrics.totalEvents ?? 0} 个事件，来自 ${metrics.sourcesCount ?? 0} 家信源。`);
  }
  return lines.join("\n");
}

/** Exported for tests: the scheduled run passes no argument, so `now` is the moment it fires. */
export { pushDaily, pushWeeklyRank, composeText };

export default defineServerModule({
  name: "wechat-push",
  schedules: [schedule, rankSchedule],
  models: { rankDescription: RANK_DESCRIPTION_STEP },
});
