import { sql } from "@aihot/backend/db";
import { otherBoards, total, type Entry } from "./tunbang.ts";
import { topBoards } from "./tophub.ts";
export interface Ranking { id: string; name: string; source: string; url: string; items: Entry[]; sourceUpdated: string | null; fetchedAt: string | null; failed: boolean; unavailable?: string }
export async function loadRankings(): Promise<Ranking[]> {
  const rows = await sql<Ranking[]>`SELECT id,name,source,url,items,source_updated AS "sourceUpdated",fetched_at AS "fetchedAt",failed FROM external_rankings ORDER BY CASE WHEN id='tunbang:all' THEN 0 ELSE 1 END,name`;
  const known = rows.some(b => b.id === total.id) ? rows : [{ ...total, items: [], sourceUpdated: null, fetchedAt: null, failed: false }, ...rows];
  return [...known, ...[...otherBoards, ...topBoards].filter(board => !known.some(b => b.id === board.id)).map(board => ({ ...board, items: [], sourceUpdated: null, fetchedAt: null, failed: false }))];
}
