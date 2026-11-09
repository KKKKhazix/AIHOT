import { sql } from "@aihot/backend/db";
import { listedCondition } from "@aihot/backend/publication/scope";
import { publicSourceName } from "@aihot/backend/publication/rules";
import { otherBoards, total, type Entry } from "./tunbang.ts";
import { topBoards } from "./tophub.ts";

export interface Ranking { id: string; name: string; source: string; url: string; items: Entry[]; sourceUpdated: string | null; fetchedAt: string | null; failed: boolean; unavailable?: string }

/** Publicly listed scored articles by publication time in a rolling window, without collapsing different reports. */
export async function loadFamilyRanking(hours: number, now: Date): Promise<Entry[]> {
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const rows = await sql<{ id: string; title: string; score: number; source_name: string }[]>`
    SELECT p.article_id AS id, p.title, p.score, s.name AS source_name
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE ${listedCondition(now)} AND p.score IS NOT NULL AND p.published_at >= ${from} AND p.published_at <= ${now}
    ORDER BY p.score DESC, p.published_at DESC, p.article_id DESC LIMIT 100`;
  return rows.map((row, index) => ({ rank: index + 1, title: row.title, url: `/items/${encodeURIComponent(row.id)}`, heat: `${row.score} 分`, origin: publicSourceName(row.source_name) }));
}

export async function loadRankings(now = new Date()): Promise<Ranking[]> {
  const [rows, ...familyItems] = await Promise.all([
    sql<Ranking[]>`SELECT id,name,source,url,items,source_updated AS "sourceUpdated",fetched_at AS "fetchedAt",failed FROM external_rankings ORDER BY CASE WHEN id='tunbang:all' THEN 0 ELSE 1 END,name`,
    ...[48, 72, 168].map(hours => loadFamilyRanking(hours, now)),
  ]);
  const family: Ranking[] = ["48小时", "3天", "7天"].map((name, index) => ({ id: `family:${[48,72,168][index]}`, name, source: "家友榜", url: "/all", items: familyItems[index], sourceUpdated: null, fetchedAt: now.toISOString(), failed: false }));
  const known = rows.some(b => b.id === total.id) ? rows : [{ ...total, items: [], sourceUpdated: null, fetchedAt: null, failed: false }, ...rows];
  const external = [...known, ...[...otherBoards, ...topBoards].filter(board => !known.some(b => b.id === board.id)).map(board => ({ ...board, items: [], sourceUpdated: null, fetchedAt: null, failed: false }))];
  const order = ["微小榜", "豚榜", "今日热榜"];
  external.sort((a, b) => (order.indexOf(a.source) < 0 ? order.length : order.indexOf(a.source)) - (order.indexOf(b.source) < 0 ? order.length : order.indexOf(b.source)));
  return [...family, ...external];
}
