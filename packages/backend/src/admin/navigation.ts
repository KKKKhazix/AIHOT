import type { AdminNavCounts } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { serverModules } from "../modules.ts";

/**
 * Items waiting for the admin, on the navigation: new feedback, failing sources, receipts and deliveries in
 * doubt, and what the modules count.
 */
export async function navCounts(): Promise<AdminNavCounts> {
  const [c] = await sql<AdminNavCounts[]>`
    SELECT (SELECT count(*)::int FROM feedback WHERE status = 'new') AS feedback,
           (SELECT count(*)::int FROM sources WHERE enabled AND health = 'failing') AS sources,
           (SELECT count(*)::int FROM receipts WHERE status = 'unknown') + (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS runs`;
  for (const m of serverModules()) for (const [key, count] of Object.entries(m.admin?.counts ?? {})) c![key] = await count();
  return c ?? {};
}
