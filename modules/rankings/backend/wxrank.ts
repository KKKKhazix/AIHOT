import { otherBoards, type Board, type Entry } from "./tunbang.ts";

export const wxBoards = otherBoards.filter(b => b.source === "微小榜");
const ranges: Record<string, string> = { "wxrank:account": "30d", "wxrank:article": "7d", "wxrank:viral": "7d" };
export function wxUrl(board: Board): string {
  const range = ranges[board.id];
  if (!range) throw new Error("unknown wxrank board");
  return `https://wxrank.com/api/rank/${board.id.slice(7)}?range=${range}&page=1`;
}
function display(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value); return Number.isFinite(n) ? String(n) : null;
}
function reads(value: unknown): string | null {
  const n = Number(value); if (!Number.isFinite(n)) return null;
  return n >= 100000 ? "10万+" : n.toLocaleString("zh-CN");
}
export function parseWxBoard(board: Board, payload: unknown): { items: Entry[]; sourceUpdated: string | null } {
  const response = payload as { code?: number; message?: string; data?: { list?: Record<string, unknown>[]; stat_date?: string } };
  if (response?.code !== 0 || !Array.isArray(response.data?.list)) throw new Error(`wxrank: ${response?.message ?? "invalid response"}`);
  const items = response.data.list.flatMap(row => {
    const rank = Number(row.rank_no); const title = board.id === "wxrank:account" ? row.wx_name : row.title;
    if (!Number.isInteger(rank) || rank < 1 || typeof title !== "string" || !title.trim()) return [];
    let url: string | null = null;
    try { const u = new URL(String(row.art_url ?? "")); if (["http:", "https:"].includes(u.protocol)) url = u.href; } catch { /* no public article URL */ }
    const account = board.id === "wxrank:account";
    const metrics = [account ? ["平均阅读", reads(row.read_avg)] : ["阅读", reads(row.read_num)],
      account ? ["WCI", display(row.wci_index)] : board.id === "wxrank:viral" ? ["爆发倍率", display(row.boost_ratio)] : ["热度分", display(row.hot_score)]]
      .filter((pair): pair is [string, string] => typeof pair[0] === "string" && typeof pair[1] === "string")
      .map(([label, value]) => `${label} ${value}`).join(" · ");
    return [{ rank, title: title.trim(), url, heat: "", origin: account ? String(row.wx_type ?? "") : String(row.wx_name ?? ""), metrics }];
  });
  if (!items.length) throw new Error("wxrank returned no valid rows");
  return { items, sourceUpdated: typeof response.data.stat_date === "string" ? response.data.stat_date : null };
}
