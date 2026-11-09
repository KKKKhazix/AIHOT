import { sql } from "@aihot/backend/db";
import { otherBoards, total, type Entry } from "./tunbang.ts";
export interface Ranking { id: string; name: string; source: string; url: string; items: Entry[]; sourceUpdated: string | null; fetchedAt: string | null; failed: boolean; unavailable?: string }
export async function loadRankings(): Promise<Ranking[]> {
  const rows = await sql<Ranking[]>`SELECT id,name,source,url,items,source_updated AS "sourceUpdated",fetched_at AS "fetchedAt",failed FROM external_rankings ORDER BY CASE WHEN id='tunbang:all' THEN 0 ELSE 1 END,name`;
  const known = rows.length ? rows : [{ ...total, items: [], sourceUpdated: null, fetchedAt: null, failed: false }];
  return [...known, ...otherBoards.map(board => ({ ...board, items: [], sourceUpdated: null, fetchedAt: null, failed: false, unavailable: board.source === "微小榜" ? "榜单接口需要登录或授权，暂未接入。" : "来源暂不可用，榜单尚未接入。" }))];
}
