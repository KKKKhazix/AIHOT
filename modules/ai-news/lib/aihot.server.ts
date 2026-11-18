import type { AiNewsHotItem, AiNewsItem } from "./aihot.shared.ts";

const BASE = "https://aihot.news";
const TTL_MS = 5 * 60 * 1000;

interface ItemsResponse {
  items: AiNewsItem[];
}

interface HotResponse {
  items: AiNewsHotItem[];
}

const cache = new Map<string, { expires: number; value: unknown }>();

async function getJson<T>(path: string): Promise<T> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && hit.expires > now) return hit.value as T;

  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "OPCHOT/1.0 (AIHOT public API consumer)",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`AIHOT API ${res.status}`);
  const value = (await res.json()) as T;
  cache.set(path, { expires: now + TTL_MS, value });
  return value;
}

export async function fetchAiNewsItems(mode: "selected" | "all", category: string | null): Promise<AiNewsItem[]> {
  const params = new URLSearchParams({ mode, window: "24h", limit: "30" });
  if (category) params.set("category", category);
  const data = await getJson<ItemsResponse>(`/api/v1/items?${params.toString()}`);
  return data.items ?? [];
}

export async function fetchAiNewsHot(): Promise<AiNewsHotItem[]> {
  const data = await getJson<HotResponse>("/api/v1/hot-topics");
  return data.items ?? [];
}
