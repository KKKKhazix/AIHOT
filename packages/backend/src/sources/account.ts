// An account source owns a post only when its trailing handle matches the post author exactly.
import { sql } from "../db.ts";

export function sourceOwnsPost(name: ReturnType<typeof sql>, handle: ReturnType<typeof sql>) {
  return sql`right(lower(${name}), length(${handle}) + 3) = '(@' || lower(nullif(${handle}, '')) || ')'`;
}
