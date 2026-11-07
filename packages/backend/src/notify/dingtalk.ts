// DingTalk custom-bot webhook delivery: a markdown message, optionally signed with the robot's secret.
// Separate from the Feishu sender because the acknowledgement differs (errcode, not code) and the URL
// may need a per-request timestamp/signature pair.
import { createHmac } from "node:crypto";
import { sql } from "../db.ts";
import { credential } from "../config.ts";
import { itemUrl } from "../publication/links.ts";
import { SITE } from "@aihot/site";

export interface DingtalkContent {
  title: string;
  sourceName: string;
  /** The original's publication date, written as on the Feishu card. */
  published: string;
  summary: string | null;
  reason: string | null;
  reasonLabel: string;
  articleId: string;
  url: string;
}

/** DingTalk renders markdown itself: keep markup characters out of model-written words. */
const escape = (text: string) => text.replace(/([\\`*_~[\]])/g, "\\$&");

/** A link target ends at the first ")" or space: percent-encode them so original URLs stay whole. */
const href = (url: string) => url.replace(/[()<> ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function dingtalkMarkdown(c: DingtalkContent): { title: string; text: string } {
  const text = [
    `**${escape(c.title)}**`,
    `${escape(c.sourceName)} · ${c.published}`,
    c.summary ? escape(c.summary) : null,
    c.reason ? `**${escape(c.reasonLabel)}**　${escape(c.reason)}` : null,
    `[${escape(`在 ${SITE.name} 阅读`)}](${href(itemUrl(c.articleId))}) ｜ [${escape("原文")}](${href(c.url)})`,
  ].filter(Boolean).join("\n\n");
  return { title: c.title, text };
}

/** The robot's secret (加签): without one the webhook URL goes out as configured. */
function signedUrl(url: string): string {
  const secret = credential("integrations", "DINGTALK_PUSH_SECRET");
  if (!secret) return url;
  const timestamp = Date.now();
  const sign = encodeURIComponent(
    createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64"),
  );
  return `${url}&timestamp=${timestamp}&sign=${sign}`;
}

async function postDingtalk(url: string, message: unknown): Promise<{ status: "sent" | "failed" | "unknown"; body: string }> {
  const res = await fetch(signedUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The wire format DingTalk expects: { msgtype: "markdown", markdown: { title, text } }.
    body: JSON.stringify({ msgtype: "markdown", markdown: message }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  // A successful HTTP transport is not an acknowledgement: proxies can return HTML or empty JSON.
  let status: "sent" | "failed" | "unknown" = res.status >= 400 && res.status < 500 ? "failed" : "unknown";
  try {
    const json = JSON.parse(body) as { errcode?: number } | null;
    if (res.ok && typeof json?.errcode === "number") status = json.errcode === 0 ? "sent" : "failed";
  } catch {
    // non-JSON body
  }
  return { status, body: body.slice(0, 500) };
}

export async function sendDingtalk(id: number, url: string, message: unknown): Promise<{ status: string }> {
  let result: Awaited<ReturnType<typeof postDingtalk>>;
  try {
    result = await postDingtalk(url, message);
  } catch (error) {
    // A timeout or lost connection may still have delivered. Never retry it automatically.
    result = { status: "unknown", body: String(error).slice(0, 500) };
  }
  await sql`UPDATE deliveries SET status = ${result.status}, response = ${result.body},
    sent_at = ${result.status === "sent" ? new Date() : null}, updated_at = now() WHERE id = ${id}`;
  return { status: result.status };
}
