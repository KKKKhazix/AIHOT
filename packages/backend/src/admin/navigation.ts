import type { AdminNavCounts } from "@aihot/contracts/admin";
import { sql } from "../db.ts";

export async function navCounts(): Promise<AdminNavCounts> {
  const [counts] = await sql<AdminNavCounts[]>`
    SELECT (SELECT count(*)::int FROM feedback WHERE status = 'new') AS feedback,
           (SELECT count(*)::int FROM sources WHERE enabled AND health = 'failing') AS sources,
           (SELECT count(*)::int FROM receipts WHERE status = 'unknown') + (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS runs,
           (SELECT count(*)::int FROM monitor_posts WHERE (recognition->>'needsReview')::boolean IS TRUE AND (recognition->>'reviewed')::boolean IS NOT TRUE AND processed_at > now() - interval '7 days')
             + (SELECT count(*)::int FROM monitor_posts WHERE processed_at IS NULL AND collected_at < now() - interval '20 minutes') AS monitor`;
  return counts ?? {};
}
