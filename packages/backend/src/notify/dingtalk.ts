// DingTalk custom-bot webhook delivery: a markdown message, optionally signed with the robot's secret.
// It goes through the Feishu sender's request and outcome rules; only the message, the acknowledgement
// (errcode, not code) and the per-request timestamp/signature pair differ.
import { createHmac } from "node:crypto";
import { credential } from "../config.ts";
import { sendWebhook } from "./feishu.ts";
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

export function postDingtalk(url: string, message: unknown): Promise<{ status: "sent" | "failed" | "unknown"; body: string }> {
  return sendWebhook(signedUrl(url), { msgtype: "markdown", markdown: message }, (json) => json?.errcode);
}
