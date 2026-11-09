import { load } from "cheerio";

export interface Board { id: string; name: string; source: string; url: string }
export interface Entry { rank: number; title: string; url: string | null; heat: string; origin: string; metrics?: string }
export const total: Board = { id: "tunbang:all", name: "全网热搜总榜", source: "豚榜", url: "https://tunbang.com/hot/" };
export const otherBoards: Board[] = [
  { id: "wxrank:account", name: "热门公众号", source: "微小榜", url: "https://wxrank.com/rank/account" },
  { id: "wxrank:article", name: "热门文章", source: "微小榜", url: "https://wxrank.com/rank/article" },
  { id: "wxrank:viral", name: "低粉爆文", source: "微小榜", url: "https://wxrank.com/rank/viral" },
  { id: "tophub:home", name: "今日热榜", source: "今日热榜", url: "https://tophub.today/" },
];
function safeUrl(href: string | undefined, base: string): string | null {
  try { const u = new URL(href ?? "", base); return href && ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; }
}
export function parseDirectory(html: string): Board[] {
  const $ = load(html); const boards: Board[] = [total];
  $("#all-bangs a.catcard").each((_, el) => {
    const href = $(el).attr("href") ?? ""; const match = /^\/hot\/([a-z0-9-]+)\/$/.exec(href);
    const name = $(el).find("h3").text().trim();
    if (match && name && !boards.some(b => b.id === `tunbang:${match[1]}`)) boards.push({ id: `tunbang:${match[1]}`, name, source: "豚榜", url: new URL(href, total.url).href });
  });
  if (boards.length < 2) throw new Error("豚榜目录为空或页面格式已变化");
  return boards;
}
export function parseBoard(html: string): { items: Entry[]; sourceUpdated: string | null } {
  const $ = load(html); const items: Entry[] = [];
  $("#list > li.row").each((_, el) => {
    const row = $(el); const a = row.find("a.row-title"); const title = a.text().trim();
    const rank = Number(row.find(".rank").first().text().trim());
    if (title && Number.isInteger(rank) && rank > 0) items.push({ rank, title, url: safeUrl(a.attr("href"), total.url), heat: row.find(".row-sub > .hot").first().text().trim(), origin: row.find(".chip").text().trim() });
  });
  if (!items.length) throw new Error("豚榜无有效条目或页面格式已变化");
  const sourceUpdated = $(".updated").first().text().match(/数据更新于\s*(\d{4}-\d\d-\d\d\s+\d\d:\d\d)/)?.[1] ?? null;
  return { items, sourceUpdated };
}
