import type { AdminNavCounts } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { serverModules } from "../modules.ts";

/**
 * Items waiting for the admin, on the navigation: new feedback, failing sources, receipts and deliveries in
 * doubt, and what the modules count.
 */
export async function navCounts(): Promise<AdminNavCounts> {
  const [[c], counts] = await Promise.all([
    sql<AdminNavCounts[]>`
    SELECT (SELECT count(*)::int FROM feedback WHERE status = 'new') AS feedback,
           (SELECT count(*)::int FROM sources WHERE enabled AND health = 'failing') AS sources,
           (SELECT count(*)::int FROM receipts WHERE status = 'unknown') + (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS runs`,
    Promise.all(serverModules().flatMap((m) => Object.entries(m.admin?.counts ?? {}).map(async ([key, count]) => [key, await count()] as const))),
  ]);
  return { ...c, ...Object.fromEntries(counts) };
}
