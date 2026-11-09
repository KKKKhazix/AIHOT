import type { Board, Entry } from "./tunbang.ts";

export const topBoards: Board[] = [
  { id: "tophub:day", name: "榜中榜 · 日榜", source: "今日热榜", url: "https://tophub.today/hot" },
];
const periods: Record<string, number> = { "tophub:day": 1 };
export function topUrl(board: Board): string {
  const period = periods[board.id];
  if (!period) throw new Error("unknown tophub board");
  return `https://open.tophub.today/hot?limit=${period}`;
}
export function parseTopBoard(board: Board, payload: unknown): { items: Entry[]; sourceUpdated: string | null } {
  const data = payload as { error?: boolean; status?: number; data?: { day?: string; limit?: number; items?: Record<string, unknown>[] } };
  if (data?.error !== false || data.status !== 200 || Number(data.data?.limit) !== periods[board.id] || !Array.isArray(data.data?.items)) throw new Error("今日热榜接口返回异常");
  const items = topItems(data.data.items);
  const day = data.data.day;
  const sourceUpdated = typeof day === "string" && /^\d{8}$/.test(day) ? `${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}` : null;
  return { items, sourceUpdated };
}

function topItems(rows: Record<string, unknown>[]): Entry[] {
  const items = rows.flatMap((row, index) => {
    if (typeof row.title !== "string" || !row.title.trim()) return [];
    let url: string | null = null;
    try { const u = new URL(String(row.url ?? "")); if (["http:", "https:"].includes(u.protocol)) url = u.href; } catch { /* no safe original URL */ }
    return [{ rank: index + 1, title: row.title.trim(), url, heat: typeof row.views === "string" ? row.views : "", origin: typeof row.sitename === "string" ? row.sitename : "" }];
  });
  if (!items.length) throw new Error("今日热榜无有效条目");
  return items;
}
