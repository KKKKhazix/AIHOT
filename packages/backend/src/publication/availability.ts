// Starred items live in the browser; this tells the page which ones are still public, and the source
// name a public one shows today (older stars saved the admin name). A starred item stays available as
// long as its page does (rules.hasItemPage), whether or not it is in the lists.
import type { ItemAvailability } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { hasItemPage, publicSourceName } from "./rules.ts";

export async function itemAvailability(ids: string[]): Promise<Record<string, ItemAvailability>> {
  const clean = [...new Set(ids.filter((id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0, 500);
  const out: Record<string, ItemAvailability> = {};
  for (const id of clean) out[id] = { status: "unavailable" };
  if (clean.length === 0) return out;
  const rows = await sql<{ id: string; visibility: string; source_mode: string; source_name: string }[]>`
    SELECT p.article_id AS id, p.visibility, s.participation_mode AS source_mode, s.name AS source_name
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id IN ${sql(clean)}`;
  for (const r of rows) {
    if (!hasItemPage({ visibility: r.visibility, sourceMode: r.source_mode })) continue;
    out[r.id] = { status: r.visibility === "summary-only" ? "summary-only" : "public", sourceName: publicSourceName(r.source_name) };
  }
  return out;
}
