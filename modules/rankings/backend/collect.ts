import { sql } from "@aihot/backend/db";
import { parseBoard, parseDirectory, total, type Board, type Entry } from "./tunbang.ts";
import { parseWxBoard, wxBoards, wxUrl } from "./wxrank.ts";

async function read(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error", headers: { "user-agent": "EduHOT rankings/1.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error("response too large");
  return html;
}
async function save(board: Board, { items, sourceUpdated }: { items: Entry[]; sourceUpdated: string | null }) {
  await sql`INSERT INTO external_rankings (id,name,source,url,items,source_updated,fetched_at,attempted_at,failed)
    VALUES (${board.id},${board.name},${board.source},${board.url},${sql.json(items as never)},${sourceUpdated},now(),now(),false)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name, source=excluded.source, url=excluded.url, items=excluded.items, source_updated=excluded.source_updated, fetched_at=now(), attempted_at=now(), failed=false`;
}
export async function collectRankings() {
  let html: string;
  let boards: Board[];
  try { html = await read(total.url); boards = parseDirectory(html); }
  catch (error) {
    await sql`UPDATE external_rankings SET attempted_at=now(), failed=true WHERE source=${total.source}`;
    throw error;
  }
  let failed = 0;
  for (const board of boards) {
    try { await save(board, parseBoard(board.id === total.id ? html : await read(board.url))); }
    catch (error) {
      failed++;
      await sql`INSERT INTO external_rankings (id,name,source,url,attempted_at,failed) VALUES (${board.id},${board.name},${board.source},${board.url},now(),true)
        ON CONFLICT (id) DO UPDATE SET name=excluded.name, attempted_at=now(), failed=true`;
      console.error("rankings collection failed", board.id, error);
    }
  }
  return { boards: boards.length, failed };
}

export async function collectWxRankings() {
  let failed = 0;
  for (const board of wxBoards) {
    try { await save(board, parseWxBoard(board, JSON.parse(await read(wxUrl(board))))); }
    catch (error) {
      failed++;
      await sql`INSERT INTO external_rankings (id,name,source,url,attempted_at,failed) VALUES (${board.id},${board.name},${board.source},${board.url},now(),true)
        ON CONFLICT (id) DO UPDATE SET attempted_at=now(), failed=true`;
      console.error("wxrank collection failed", board.id, error);
    }
  }
  return { boards: wxBoards.length, failed };
}
