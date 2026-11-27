// Both current ids and historical merge chains resolve to one live story. Reports join
// this query on their stored story id; callers with an id can read its row directly.
import { sql } from "../db.ts";

export function survivingStory(id: number | ReturnType<typeof sql>) {
  return sql<{ id: number; public_id: string }[]>`
    WITH RECURSIVE chain AS (
      SELECT id, public_id, merged_into FROM stories WHERE id = ${id}
      UNION ALL
      SELECT s.id, s.public_id, s.merged_into FROM stories s JOIN chain c ON s.id = c.merged_into
    )
    SELECT id, public_id FROM chain WHERE merged_into IS NULL LIMIT 1`;
}
