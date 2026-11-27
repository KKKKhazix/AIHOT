// Feishu HTTP transport: message app (tenant token, image upload/download, chat messages),
// operations alert delivery (Agent hub /tell, alert webhook, fallback ops chat) and content webhooks.
// Alert domain types/formatters live in lib/alerts.ts; feedback forwarding lives in operations/feedback.ts.
// Everything outward is off unless explicitly enabled (development and tests stay silent).
import { createHash } from "node:crypto";
import { config, credential, feishuInternalEnabled } from "../config.ts";

const API = "https://open.feishu.cn/open-apis";

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

/** Feishu's answers that the picture itself is unacceptable (bad image, too large, empty): trying again cannot help. */
const IMAGE_REFUSED = new Set([234001, 234006, 234010, 234011]);

export class ImageRefusedError extends Error {}

export async function uploadImage(data: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.set("image_type", "message");
  form.set("image", new Blob([new Uint8Array(data)]), filename);
  const res = await fetch(`${API}/im/v1/images`, { method: "POST", headers: { authorization: `Bearer ${await tenantToken()}` }, body: form, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json()) as { code: number; data?: { image_key: string }; msg?: string };
  if (IMAGE_REFUSED.has(json.code)) throw new ImageRefusedError(`feishu upload: ${json.msg}`);
  if (json.code !== 0 || !json.data) throw new Error(`feishu upload: ${json.msg}`);
  return json.data.image_key;
}

/** A picture this app uploaded, read back by its key (Feishu gives an app only its own uploads). */
export async function downloadImage(imageKey: string): Promise<Buffer> {
  const res = await fetch(`${API}/im/v1/images/${encodeURIComponent(imageKey)}`, { headers: { authorization: `Bearer ${await tenantToken()}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`feishu image: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function sendToChat(chatId: string, msgType: "text" | "post" | "interactive", content: unknown): Promise<string> {
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

/**
 * The hub sends the notification to the owner. A private message ID lets the caller retry exactly
 * that notice through the hub. Other alerts use the existing group channel if the hub is unavailable.
 */
export async function sendAlert(title: string, lines: string[], privateMessageId?: string): Promise<"sent" | "disabled" | "pending"> {
  // Production needs no label; any other environment that has sending on says which one it is.
  const text = `${config.environmentName === "production" ? "" : `【${config.environmentName}】`}${title}\n${lines.join("\n")}`;
  if (!feishuInternalEnabled()) {
    console.log(JSON.stringify({ level: "warn", msg: "alert (not sent: FEISHU_INTERNAL_ENABLED is off)", title, lines }));
    return "disabled";
  }
  const rest = await toldThroughHub(webhookPieces(text), privateMessageId);
  if (!rest.length) return "sent";
  if (privateMessageId) return "pending";
  const webhook = credential("integrations", "FEISHU_ALERT_WEBHOOK_URL");
  if (webhook) {
    for (const piece of rest) {
      const result = await webhookTurn(() => sendWebhook(webhook, { msg_type: "text", content: { text: piece } }));
      if (result.status !== "sent") throw new Error(`feishu alert webhook ${result.status}: ${result.body}`);
    }
    return "sent";
  }
  const chat = credential("integrations", "FEISHU_ALERT_CHAT_ID") ?? credential("integrations", "FEISHU_INTERNAL_CHAT_ID");
  if (!chat) return "disabled";
  await sendToChat(chat, "text", { text: rest.join("") });
  return "sent";
}

/**
 * Hands the pieces to the hub's /tell with the source key, each under its own message key.
 * Returns the unsent pieces so the caller can apply the alert's delivery policy.
 */
async function toldThroughHub(pieces: string[], messageId?: string): Promise<string[]> {
  const hub = credential("integrations", "WEBHOOK_HUB_URL");
  const key = credential("integrations", "WEBHOOK_HUB_KEY");
  if (!hub || !key) return pieces;
  const id = messageId ?? `alert-${Date.now()}-${createHash("sha256").update(pieces.join("")).digest("hex").slice(0, 12)}`;
  for (const [i, piece] of pieces.entries()) {
    try {
      const res = await fetch(new URL("/tell", hub), {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ key: `${id}-${i}`, text: piece }), signal: AbortSignal.timeout(15_000),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      console.error(JSON.stringify({ level: "warn", msg: "alert not taken by the hub", taken: i, error: String(error) }));
      return pieces.slice(i);
    }
  }
  return [];
}

// A custom bot takes at most 5 requests a second, 100 a minute and 20 KB a request (Feishu's custom bot
// guide); the app's text messages took 150 KB. One check can send many alerts, and the digests are long.
const WEBHOOK_GAP_MS = 600;
const WEBHOOK_TEXT_BYTES = 18_000;
let webhookQueue: Promise<void> = Promise.resolve();
let webhookLast = -Infinity;

/**
 * One request at a time, sent the gap after the last one was answered or failed: Feishu got that one before
 * it answered, so however late a timer, a request or an answer, it never gets two closer than the gap.
 */
function webhookTurn<T>(send: () => Promise<T>): Promise<T> {
  const turn = webhookQueue.then(async () => {
    // Checked again after the timer, which can fire a millisecond early by this clock.
    let wait: number;
    while ((wait = webhookLast + WEBHOOK_GAP_MS - performance.now()) > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await send();
    } finally {
      webhookLast = performance.now();
    }
  });
  webhookQueue = turn.then(() => undefined, () => undefined);
  return turn;
}

/** Bytes the text takes in the request body, where quotes, backslashes and line breaks are escaped. */
const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;

/** The text in pieces that fit a request, cut after a line where one fits; joined they are the text. */
function webhookPieces(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (jsonBytes(rest) > WEBHOOK_TEXT_BYTES) {
    let end = 0;
    let bytes = 0;
    for (const ch of rest) {
      bytes += jsonBytes(ch);
      if (bytes > WEBHOOK_TEXT_BYTES) break;
      end += ch.length;
    }
    const line = rest.lastIndexOf("\n", end - 1);
    if (line > 0) end = line + 1;
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  pieces.push(rest);
  return pieces;
}

/** Custom-bot webhook for content groups (selected cards and other pushes). */
export function postWebhook(url: string, card: unknown): Promise<{ status: "sent" | "failed" | "unknown"; body: string }> {
  return sendWebhook(url, { msg_type: "interactive", card });
}

/**
 * POST a custom-bot message and read the acknowledgement. `code` picks the bot's result code (0 = accepted)
 * from its JSON answer; the other bots (notify/dingtalk.ts) differ only there.
 */
export async function sendWebhook(
  url: string, message: unknown,
  code: (json: Record<string, unknown> | null) => unknown = (json) => json?.code ?? json?.StatusCode,
): Promise<{ status: "sent" | "failed" | "unknown"; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  // A successful HTTP transport is not an acknowledgement: proxies can return HTML or empty JSON.
  let status: "sent" | "failed" | "unknown" = res.status >= 400 && res.status < 500 ? "failed" : "unknown";
  try {
    const result = code(JSON.parse(body) as Record<string, unknown> | null);
    if (res.ok && typeof result === "number") status = result === 0 ? "sent" : "failed";
  } catch {
    // non-JSON body
  }
  return { status, body: body.slice(0, 500) };
}
