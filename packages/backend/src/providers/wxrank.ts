// WeChat official-account data through wxrank's real-time API. The documented per-call prices are
// ¥0.05 for getps and ¥0.01 for artinfo; keep both calls behind receipts and the wxrank budget.
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { assertAccepted, paidRequest, ProviderRejectedError, type CallOutcome } from "./receipts.ts";

export interface MpPost {
  position: number;
  url: string;
  title: string;
  post_time: number;
  digest?: string;
  sn?: string;
  cover_url?: string;
  original?: number;
  item_show_type?: number;
}

export interface MpHistory {
  posts: MpPost[];
  nickname: string | null;
  remainMoney: number | null;
  receiptId: number;
  reused: boolean;
}

export interface MpArticle {
  title: string;
  content: string;
  author: string | null;
  desc: string | null;
  pubtime: string | null;
  receiptId: number;
}

export interface MpAccountInfo {
  biz: string;
  ghid: string | null;
  name: string | null;
  type: string | null;
  accountType: string | null;
  avatar: string | null;
  articleCount: number | null;
  originalArticleCount: number | null;
  region: string | null;
  verifiedPrincipal: string | null;
  description: string | null;
  tags: string[];
  nameHistory: string[];
  lastPublishedAt: number | null;
  updatedAt: number | null;
  stats: Record<string, unknown> | null;
  receiptId: number;
  reused: boolean;
}

export function wxrankConfigured(): boolean {
  return credential("collectors", "WXRANK_KEY") !== null;
}

const BASE_URL = "https://data.wxrank.com/weixin";

function apiKey(): string {
  const key = credential("collectors", "WXRANK_KEY");
  if (!key) throw new Error("WXRANK_KEY is not configured");
  return key;
}

function providerOutcome(json: { code?: number; msg?: string }, endpoint: string, estimatedCost: number): CallOutcome["cost"] {
  const code = Number(json.code ?? -1);
  if (code === 0) return { amount: estimatedCost, currency: "CNY", basis: "estimated" };
  const retryable = code === 9999 || code === 1004 || code === 1005;
  const refused = code === 1000;
  const detail = JSON.stringify({ code, message: json.msg ?? "" });
  throw new ProviderRejectedError(refused ? `wxrank HTTP 402: ${detail}` : retryable ? `wxrank HTTP 429: ${detail}` : `wxrank ${endpoint}: ${detail}`, refused ? 402 : retryable ? 429 : code, retryable, refused);
}

function parseJson(text: string, endpoint: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`wxrank ${endpoint}: invalid JSON response`);
  return data as Record<string, unknown>;
}

async function post(endpoint: "getps" | "artinfo" | "gzhinfo", body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await guardedFetch(`${BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ key: apiKey(), ...body }),
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
    route: "direct",
  });
  const text = res.text();
  assertAccepted("wxrank", res.status, text);
  return parseJson(text, endpoint);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

/** Account profile from wxrank's local library, looked up by Biz or original ID. Successful empty lookups are billed ¥0.05. */
export async function mpAccountInfoByKeyword(keyword: string, opts: { subject: string }): Promise<{ found: boolean; account: MpAccountInfo | null; receiptId: number; reused: boolean }> {
  const normalizedKeyword = keyword.trim();
  const day = new Date().toISOString().slice(0, 10);
  const receipt = await paidRequest(
    { service: "wxrank", purpose: "mp_account_info", subject: opts.subject, identity: { biz: normalizedKeyword, day }, requestSummary: { keyword: normalizedKeyword } },
    async () => {
      const response = await post("gzhinfo", { keyword: normalizedKeyword });
      const cost = providerOutcome(response as { code?: number; msg?: string }, "gzhinfo", 0.05);
      const data = asRecord(response.data);
      return { response, cost, usage: { found: Object.keys(data).length > 0 } };
    },
  );
  const response = asRecord(receipt.response);
  const data = asRecord(response.data);
  if (!Object.keys(data).length) return { found: false, account: null, receiptId: receipt.receiptId, reused: receipt.reused };
  const tags = Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const nameHistory = Array.isArray(data.name_history) ? data.name_history.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    found: true,
    account: {
      biz: asStringOrNull(data.wx_biz) ?? (/^gh_/i.test(normalizedKeyword) ? "" : normalizedKeyword),
      ghid: asStringOrNull(data.wx_user),
      name: asStringOrNull(data.wx_name),
      type: asStringOrNull(data.wx_type),
      accountType: asStringOrNull(data.wx_push),
      avatar: asStringOrNull(data.avatar),
      articleCount: asNumberOrNull(data.art_total),
      originalArticleCount: asNumberOrNull(data.ori_total),
      region: asStringOrNull(data.region),
      verifiedPrincipal: asStringOrNull(data.verify),
      description: asStringOrNull(data.description),
      tags,
      nameHistory,
      lastPublishedAt: asNumberOrNull(data.last_pub_time),
      updatedAt: asNumberOrNull(data.update_time),
      stats: Object.keys(asRecord(data.stats)).length ? asRecord(data.stats) : null,
      receiptId: receipt.receiptId,
      reused: receipt.reused,
    },
    receiptId: receipt.receiptId,
    reused: receipt.reused,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parsePublicationTime(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const date = new Date(`${value.replace(" ", "T")}+08:00`);
  return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : 0;
}

function parsePosition(url: string): number {
  try { return Number(new URL(url).searchParams.get("idx")) || 1; } catch { return 1; }
}

function parsePosts(value: unknown): MpPost[] {
  if (!Array.isArray(value)) throw new Error("wxrank getps: successful response has no data.list; outcome needs reconciliation");
  return value.map((entry) => {
    const row = asRecord(entry);
    const url = asString(row.art_url);
    return {
      position: parsePosition(url), url, title: asString(row.title), post_time: parsePublicationTime(row.pub_time),
      sn: asString(row.sn) || undefined, cover_url: asString(row.pic_url) || undefined,
    };
  });
}

/** Latest page of account posts. wxrank getps charges ¥0.05 per successful call. */
export async function mpHistory(wxid: string, opts: { subject: string; window: string }): Promise<MpHistory> {
  const receipt = await paidRequest(
    { service: "wxrank", purpose: "mp_history", subject: opts.subject, identity: { wxid, window: opts.window }, requestSummary: { wxid } },
    async () => {
      const response = await post("getps", { wxid });
      const cost = providerOutcome(response as { code?: number; msg?: string }, "getps", 0.05);
      const data = asRecord(response.data);
      const posts = parsePosts(data.list);
      return { response, cost, usage: { posts: posts.length } };
    },
  );
  const response = asRecord(receipt.response);
  const data = asRecord(response.data);
  const posts = parsePosts(data.list);
  return { posts, nickname: null, remainMoney: null, receiptId: receipt.receiptId, reused: receipt.reused };
}

/** Article metadata and HTML body. wxrank artinfo charges ¥0.01 per successful call. */
export async function mpArticle(articleUrl: string, opts: { subject: string; identity: string }): Promise<MpArticle> {
  const receipt = await paidRequest(
    { service: "wxrank", purpose: "mp_article", subject: opts.subject, identity: { article: opts.identity }, requestSummary: { url: articleUrl } },
    async () => {
      const response = await post("artinfo", { url: articleUrl });
      const cost = providerOutcome(response as { code?: number; msg?: string }, "artinfo", 0.01);
      const data = asRecord(response.data);
      if (!Object.keys(data).length) throw new Error("wxrank artinfo: successful response has no data; outcome needs reconciliation");
      return { response, cost, usage: { chars: asString(data.html || data.text).length } };
    },
  );
  const data = asRecord(asRecord(receipt.response).data);
  return {
    title: asString(data.title), content: asString(data.html) || asString(data.text),
    author: asString(data.author) || null, desc: asString(data.digest) || null,
    pubtime: asString(data.pub_time) || null, receiptId: receipt.receiptId,
  };
}
