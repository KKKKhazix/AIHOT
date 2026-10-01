// Feishu delivery. Two separate apps: the login app (admin OAuth) and the message app (internal
// feedback chat, operations alert chat, image upload). Content groups use custom bot webhooks.
// Alerts and feedback never go to content groups, and content never goes to internal chats.
// Everything outward is off unless explicitly enabled (development and parallel runs stay silent).
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";

const API = "https://open.feishu.cn/open-apis";

export const feishuInternalEnabled = () => process.env.FEISHU_INTERNAL_ENABLED === "true";

let tokenCache: { token: string; expires: number } | null = null;

async function tenantToken(): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const appId = credential("integrations", "FEISHU_APP_ID");
  const appSecret = credential("integrations", "FEISHU_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Feishu message app is not configured");
  const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { code: number; tenant_access_token?: string; expire?: number; msg?: string };
  if (json.code !== 0 || !json.tenant_access_token) throw new Error(`feishu token: ${json.msg}`);
  tokenCache = { token: json.tenant_access_token, expires: Date.now() + (json.expire ?? 3600) * 1000 };
  return tokenCache.token;
}

async function uploadImage(data: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.set("image_type", "message");
  form.set("image", new Blob([new Uint8Array(data)]), filename);
  const res = await fetch(`${API}/im/v1/images`, { method: "POST", headers: { authorization: `Bearer ${await tenantToken()}` }, body: form, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json()) as { code: number; data?: { image_key: string }; msg?: string };
  if (json.code !== 0 || !json.data) throw new Error(`feishu upload: ${json.msg}`);
  return json.data.image_key;
}

async function sendToChat(chatId: string, msgType: "text" | "post" | "interactive", content: unknown): Promise<string> {
  const res = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await tenantToken()}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { code: number; data?: { message_id: string }; msg?: string };
  if (json.code !== 0) throw new Error(`feishu send: ${json.msg}`);
  return json.data?.message_id ?? "";
}

// ---- Operations alerts ------------------------------------------------------------------------------
// Read by the site owner, not an engineer (operations/alerts.ts): what readers see, whether it heals,
// what the owner must do, and a last line of detail for the AI or engineer it is forwarded to.

export type Level = "now" | "today" | "digest";

export interface Finding {
  key: string;
  level: Level;
  /** Plain words: no queue, unit or table names. */
  title: string;
  /** What readers see, or what it costs. */
  impact?: string;
  /** Whether it heals by itself. */
  heals?: string;
  /** What the owner has to do ("转给 AI" when it is engineering work). */
  action?: string;
  /** For the AI or engineer the owner forwards it to. */
  detail?: string;
  /** When the problem began, when known; otherwise when it was first seen. */
  since?: Date;
}

const MARK: Record<Exclude<Level, "digest">, string> = { now: "🔴", today: "🟠" };

/** "9月29日" in Beijing time. */
export function beijingDay(at: Date | string | number): string {
  const [, m, d] = beijingDate(at).split("-").map(Number);
  return `${m}月${d}日`;
}

/** "9月29日 13:40" in Beijing time. */
export const beijingStamp = (at: Date | string | number) => `${beijingDay(at)} ${beijingTime(at)}`;

export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分钟` : ""}`;
  return `${Math.floor(min / 1440)} 天`;
}

/** The message for an open problem: first notice or a repeat. */
export function formatAlert(f: Finding, since: Date, now: number, repeat = false): { title: string; lines: string[] } {
  const level = f.level === "digest" ? "today" : f.level;
  const lasting = now - since.getTime() >= 60_000 ? `（已持续 ${duration(now - since.getTime())}）` : "";
  const lines = [f.impact && `影响：${f.impact}`, f.heals && `会自己好吗：${f.heals}`, f.action && `你需要：${f.action}`, f.detail && `给 AI 的细节：${f.detail}`];
  return { title: `${MARK[level]} ${repeat ? "仍未恢复：" : ""}${f.title}${lasting}`, lines: lines.filter((l): l is string => !!l) };
}

export function formatRecovery(title: string, since: Date, now: number): { title: string; lines: string[] } {
  return { title: `✅ 已恢复：${title}`, lines: [`持续 ${duration(now - since.getTime())}（${beijingStamp(since)} 起）`] };
}

/** Operations alert: the alert chat, falling back to the internal feedback chat — never a content group. */
export async function sendAlert(title: string, lines: string[]): Promise<"sent" | "disabled"> {
  // Production needs no label; any other environment that has sending on says which one it is.
  const text = `${config.environmentName === "production" ? "" : `【${config.environmentName}】`}${title}\n${lines.join("\n")}`;
  if (!feishuInternalEnabled()) {
    console.log(JSON.stringify({ level: "warn", msg: "alert (not sent: FEISHU_INTERNAL_ENABLED is off)", title, lines }));
    return "disabled";
  }
  const chat = credential("integrations", "FEISHU_ALERT_CHAT_ID") ?? credential("integrations", "FEISHU_INTERNAL_CHAT_ID");
  if (!chat) return "disabled";
  await sendToChat(chat, "text", { text });
  return "sent";
}

/** A screenshot that still cannot be uploaded this long after the feedback is given up: the text goes without it. */
const SCREENSHOT_GIVE_UP_MS = 24 * 3600_000;

/**
 * The screenshot to attach, uploaded now or on an earlier try. Only the Feishu image key is kept (privacy
 * notice): the local file is removed once uploaded, or once the upload is given up.
 */
async function screenshotFor(fb: { id: number; screenshot_key: string | null; created_at: Date }): Promise<{ imageKey: string | null; note: string | null }> {
  const key = fb.screenshot_key;
  if (key?.startsWith("feishu:")) return { imageKey: key.slice("feishu:".length), note: null };
  if (key === "gone:upload") return { imageKey: null, note: "（截图未能上传，已删除）" };
  if (key === "gone:missing") return { imageKey: null, note: "（截图文件已不存在）" };
  if (!key?.startsWith("local:")) return { imageKey: null, note: null };
  const file = path.join(config.dataDir, "feedback-screenshots", key.slice("local:".length));
  const data = await readFile(file).catch(() => null);
  if (!data) {
    await sql`UPDATE feedback SET screenshot_key = 'gone:missing' WHERE id = ${fb.id}`;
    return { imageKey: null, note: "（截图文件已不存在）" };
  }
  try {
    const imageKey = await uploadImage(data, path.basename(file));
    await sql`UPDATE feedback SET screenshot_key = ${`feishu:${imageKey}`} WHERE id = ${fb.id}`;
    await unlink(file).catch(() => {});
    return { imageKey, note: null };
  } catch (error) {
    // The forwarding sweep tries again; after a day the text goes without it.
    if (Date.now() - fb.created_at.getTime() < SCREENSHOT_GIVE_UP_MS) throw error;
    await sql`UPDATE feedback SET screenshot_key = 'gone:upload' WHERE id = ${fb.id}`;
    await unlink(file).catch(() => {});
    return { imageKey: null, note: "（截图未能上传，已删除）" };
  }
}

/**
 * Forwards one feedback to the internal chat, with its screenshot. Until that succeeds the feedback keeps
 * the reason in forward_error, and the forwarding sweep (operations/feedback.ts) tries it again.
 */
export async function forwardFeedbackToFeishu(id: number): Promise<"sent" | "disabled"> {
  if (!feishuInternalEnabled()) return "disabled";
  const chat = credential("integrations", "FEISHU_INTERNAL_CHAT_ID");
  if (!chat) return "disabled";
  const [fb] = await sql<{ id: number; content: string; email: string | null; note: string | null; page_url: string | null; screenshot_key: string | null; created_at: Date }[]>`
    SELECT id, content, email, note, page_url, screenshot_key, created_at FROM feedback WHERE id = ${id} AND forwarded_at IS NULL`;
  if (!fb) return "disabled";
  try {
    const shot = await screenshotFor(fb);
    const paragraphs: unknown[][] = [
      [{ tag: "text", text: fb.content }],
      [{ tag: "text", text: `页面：${fb.page_url ?? "—"}` }],
      [{ tag: "text", text: `邮箱：${fb.email ?? "（未留）"}` }],
    ];
    if (fb.note) paragraphs.push([{ tag: "text", text: fb.note }]);
    if (shot.imageKey) paragraphs.push([{ tag: "img", image_key: shot.imageKey }]);
    else if (shot.note) paragraphs.push([{ tag: "text", text: shot.note }]);
    await sendToChat(chat, "post", { zh_cn: { title: `反馈 #${fb.id}`, content: paragraphs } });
    await sql`UPDATE feedback SET forwarded_at = now(), forward_error = NULL WHERE id = ${id}`;
    return "sent";
  } catch (error) {
    await sql`UPDATE feedback SET forward_error = ${String(error instanceof Error ? error.message : error).slice(0, 300)} WHERE id = ${id}`;
    throw error;
  }
}

/** Custom-bot webhook for content groups (selected cards, reset pushes). */
export async function postWebhook(url: string, card: unknown): Promise<{ status: "sent" | "failed" | "unknown"; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  // A successful HTTP transport is not an acknowledgement: proxies can return HTML or empty JSON.
  let status: "sent" | "failed" | "unknown" = res.status >= 400 && res.status < 500 ? "failed" : "unknown";
  try {
    const json = JSON.parse(body) as { code?: number; StatusCode?: number } | null;
    const code = json?.code ?? json?.StatusCode;
    if (res.ok && typeof code === "number") status = code === 0 ? "sent" : "failed";
  } catch {
    // non-JSON body
  }
  return { status, body: body.slice(0, 500) };
}
