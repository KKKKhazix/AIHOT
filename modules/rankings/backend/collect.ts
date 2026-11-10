import { sql } from "@aihot/backend/db";
import { parseBoard, parseDirectory, total, type Board, type Entry } from "./tunbang.ts";
import { parseWxBoard, wxBoards, wxUrl } from "./wxrank.ts";
import { parseTopBoard, topBoards, topUrl } from "./tophub.ts";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";

async function read(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error", headers: { "user-agent": "EduHOT rankings/1.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error("response too large");
  return html;
}
async function save(board: Board, { items, sourceUpdated }: { items: Entry[]; sourceUpdated: string | null }) {
  const fetchedAt = new Date();
  const publicItems = items.map(({ raw: _raw, ...item }) => item);
  await sql.begin(async tx => {
    await tx`INSERT INTO external_rankings (id,name,source,url,items,source_updated,fetched_at,attempted_at,failed)
      VALUES (${board.id},${board.name},${board.source},${board.url},${tx.json(publicItems as never)},${sourceUpdated},${fetchedAt},now(),false)
      ON CONFLICT (id) DO UPDATE SET name=excluded.name, source=excluded.source, url=excluded.url, items=excluded.items, source_updated=excluded.source_updated, fetched_at=excluded.fetched_at, attempted_at=now(), failed=false`;
    const period = board.id === "wxrank:account" ? "30d" : board.id.startsWith("wxrank:") ? "7d" : board.id === "tophub:day" ? "1d" : null;
    await tx`INSERT INTO external_ranking_snapshots (board_id,name,source,url,period,items,source_updated,fetched_at,rule_version,rule_prompt)
      VALUES (${board.id},${board.name},${board.source},${board.url},${period},${tx.json(items as never)},${sourceUpdated},${fetchedAt},${promptVersion("rankings-screen")},${promptText("rankings-screen")})`;
  });
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

export async function collectTopRankings() {
  const board = topBoards[0];
  try {
    await save(board, parseTopBoard(board, JSON.parse(await read(topUrl(board)))));
    return { boards: 1, failed: 0 };
  } catch (error) {
    await sql`INSERT INTO external_rankings (id,name,source,url,attempted_at,failed) VALUES (${board.id},${board.name},${board.source},${board.url},now(),true)
      ON CONFLICT (id) DO UPDATE SET attempted_at=now(), failed=true`;
    throw error;
  }
}
