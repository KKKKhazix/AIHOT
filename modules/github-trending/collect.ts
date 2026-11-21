import { ProxyAgent, fetch as uFetch } from "undici";
import type { Db } from "@aihot/backend/db";
import { parseTrending, type Period, type TrendingRow } from "./parse.ts";
import { saveSnapshot } from "./store.ts";

export interface CollectDeps {
  db: Db;
  fetchHtml: (url: string) => Promise<string>;
  push: (rows: TrendingRow[]) => Promise<void>;
}

export const trendingUrl = (period: Period) => `https://github.com/trending?since=${period}`;

export async function collectTrending(period: Period, deps: CollectDeps): Promise<void> {
  const html = await deps.fetchHtml(trendingUrl(period));
  const rows = parseTrending(html);
  if (rows.length === 0) throw new Error(`no trending rows parsed (${period})`);
  await saveSnapshot(deps.db, period, rows);
  if (period === "daily") await deps.push(rows.slice(0, 10));
}

export async function fetchViaProxy(url: string): Promise<string> {
  const proxy = process.env.EGRESS_PROXY_URL;
  const res = await uFetch(url, {
    dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "Mozilla/5.0 (workbench-trending)" },
  });
  if (!res.ok) throw new Error(`trending fetch HTTP ${res.status}`);
  return res.text();
}

export async function pushToIngest(rows: TrendingRow[]): Promise<void> {
  const base = process.env.API_BASE_URL;
  const token = process.env.INGEST_TOKEN;
  if (!base || !token) throw new Error("API_BASE_URL / INGEST_TOKEN not configured");
  const res = await uFetch(`${base}/api/ingest/items`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      sourceId: "github-trending",
      sourceName: "GitHub Trending",
      items: rows.map((r) => ({ title: r.repo, url: r.url, publishedAt: new Date().toISOString(), author: r.language ?? undefined })),
    }),
  });
  if (!res.ok) throw new Error(`ingest HTTP ${res.status}: ${await res.text()}`);
}
