// Selectable WeChat data source. wxrank is the default; setting WECHAT_PROVIDER=dajiala keeps the
// existing Dajiala integration available. Provider-specific receipts and budgets remain separate.
import { credential } from "../config.ts";
import * as dajiala from "./dajiala.ts";
import * as wxrank from "./wxrank.ts";

export type WechatProvider = "wxrank" | "dajiala";
export type MpPost = wxrank.MpPost;
export type MpHistory = wxrank.MpHistory;
export type MpArticle = wxrank.MpArticle;

export function mpProviderName(): WechatProvider {
  const configured = credential("collectors", "WECHAT_PROVIDER")?.toLowerCase();
  if (!configured || configured === "wxrank") return "wxrank";
  if (configured === "dajiala") return "dajiala";
  throw new Error(`WECHAT_PROVIDER must be wxrank or dajiala; received ${configured}`);
}

export function mpProviderConfigured(): boolean {
  return mpProviderName() === "wxrank" ? wxrank.wxrankConfigured() : dajiala.dajialaConfigured();
}

export function mpHistory(accountId: string, opts: { subject: string; window: string }): Promise<MpHistory> {
  return mpProviderName() === "wxrank" ? wxrank.mpHistory(accountId, opts) : dajiala.mpHistory(accountId, opts);
}

export function mpArticle(articleUrl: string, opts: { subject: string; identity: string }): Promise<MpArticle> {
  return mpProviderName() === "wxrank" ? wxrank.mpArticle(articleUrl, opts) : dajiala.mpArticle(articleUrl, opts);
}
