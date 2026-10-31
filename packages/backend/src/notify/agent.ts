// Publish durable, source-owned events to the shared hub. Its documented idempotency contract makes
// uncertain HTTP results safe to retry with the same ID. Execution/claim/retry state belongs to the hub.
import { createHash } from "node:crypto";
import { credential, config } from "../config.ts";
import { sql } from "../db.ts";
import { feishuInternalEnabled, type Finding } from "./feishu.ts";

interface Event { id: string; type: string; subject: string; summary: string; detail: string; link: string }
interface Receipt { event: Event; accepted: boolean; queuedAt: string; lastError?: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const subject = (key: string) => /^[A-Za-z0-9#._:/@-]{1,100}$/.test(key) ? key : `finding:${hash(key)}`;
const clip = (text: string, n: number) => text.slice(0, n);
/** Whether an agent takes the alerts: events go to the hub, which wakes it. */
export const agentConfigured = () => feishuInternalEnabled() && !!credential("integrations", "WEBHOOK_HUB_URL") && !!credential("integrations", "WEBHOOK_HUB_KEY");

/** Whether the hub has the event. */
async function deliver(key: string, receipt: Receipt): Promise<boolean> {
  if (receipt.accepted) return true;
  if (!agentConfigured()) return false;
  let failure = "网络连接失败或超时";
  try {
    const res = await fetch(credential("integrations", "WEBHOOK_HUB_URL")!, {
      method: "POST", redirect: "error", headers: { authorization: `Bearer ${credential("integrations", "WEBHOOK_HUB_KEY")!}`, "content-type": "application/json" },
      body: JSON.stringify(receipt.event), signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 200) {
      await sql`UPDATE settings SET value=value || '{"accepted":true}'::jsonb,updated_at=now() WHERE key=${key}`;
      return true;
    }
    failure = `HTTP ${res.status}`;
  } catch {
    // Timeout may mean accepted: keep the exact persisted ID for the next attempt. Never block owner alerts.
  }
  await sql`UPDATE settings SET value=value || ${sql.json({lastError:failure})},updated_at=now() WHERE key=${key}`;
  return false;
}

/** Transport diagnosis only; execution and claims still belong exclusively to the hub. */
export async function agentTransportFindings(now: number): Promise<Finding[]> {
  const rows = await sql<{value:Receipt}[]>`SELECT value FROM settings WHERE key LIKE 'webhook.event.%' AND value->>'accepted'='false'`;
  const stuck = rows.filter(r => now-Date.parse(r.value.queuedAt) >= 30*60_000);
  return stuck.length ? [{key:'webhook.transport',level:'today',owner:true,title:'自动处理暂时接不到任务',
    impact:'交给 AI 处理的告警送不到它那里；恢复之前，这些告警直接发给你',heals:'尚未确认恢复',action:'核对中台连接和来源配置',
    detail:`${stuck.length} 项未送达；${[...new Set(stuck.map(r=>r.value.lastError ?? '尚未投递'))].join('、')}`}]:[];
}

/** How many problems under this key were handed to the agent since then: each incident is one event. */
export async function handoffs(key: string, since: Date): Promise<number> {
  const [row] = await sql<{n:number}[]>`SELECT count(*)::int AS n FROM settings WHERE key LIKE 'webhook.event.%'
    AND value->'event'->>'subject'=${subject(key)} AND value->'event'->>'type' IN ('alert.now','alert.today')
    AND (value->>'queuedAt')::timestamptz>=${since}`;
  return row!.n;
}

async function publish(event: Event, now = Date.now()): Promise<boolean> {
  if (!agentConfigured()) return false;
  const key = `webhook.event.${hash(event.id)}`;
  await sql`INSERT INTO settings(key,value,updated_by) VALUES(${key},${sql.json({event:{...event},accepted:false,queuedAt:new Date(now).toISOString()})},'alerts') ON CONFLICT(key) DO NOTHING`;
  const [row] = await sql<{value:Receipt}[]>`SELECT value FROM settings WHERE key=${key}`;
  return deliver(key, row!.value);
}

/** Retry only pending transport receipts, never re-dispatch an accepted event. */
export async function flushAgentEvents(): Promise<void> {
  if (!agentConfigured()) return;
  const rows = await sql<{key:string;value:Receipt}[]>`SELECT key,value FROM settings WHERE key LIKE 'webhook.event.%' AND value->>'accepted'='false' ORDER BY updated_at LIMIT 20`;
  for (const row of rows) await deliver(row.key,row.value);
}

export async function wakeAgent(f: Finding, now = Date.now()): Promise<void> {
  const identity = f.agentOnly ? f.key : `${f.key}:${f.since!.toISOString()}`;
  await publish({
    id: identity.length <= 200 ? identity : `alert:${hash(identity)}`,
    type: f.agentOnly ? "alert.review" : f.level === "today" ? "alert.today" : "alert.now",
    subject: subject(f.key), summary: clip(f.title,200), detail: clip([f.impact,f.detail].filter(Boolean).join("\n"),4000),
    link: new URL("/admin/runs",config.siteUrl).href,
  }, now);
}

/** Called after the daily follow-up message was generated. No model or separate scheduler here. */
/** Whether the hub took the day's list. */
export async function wakeDigest(date: string, count: number): Promise<boolean> {
  return publish({id:`digest:${date}`,type:"alert.digest",subject:`digest:${date}`,summary:`系统日报 ${date}`,detail:`${count} 项待跟进`,link:new URL("/admin/runs",config.siteUrl).href});
}
