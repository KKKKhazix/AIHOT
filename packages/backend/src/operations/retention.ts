// Daily housekeeping: expired leases, old run history, feedback screenshots left behind and derived caches,
// and the site's modules' own periods (their server.ts retention).
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { screenshotsForwarded } from "./feedback.ts";
import { serverModules } from "../modules.ts";

/** Removes files under `dir` last written more than `maxAgeMs` ago. */
async function removeOlderThan(dir: string, maxAgeMs: number, now: number): Promise<number> {
  let removed = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const info = await stat(p).catch(() => null);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await unlink(p).catch(() => {});
        removed += 1;
      }
    }
  };
  await walk(dir);
  return removed;
}

export async function dailyRetention(now = new Date()) {
  // The modules' periods first (their aggregates before their deletions, as the engine's).
  const modules: Record<string, unknown> = {};
  for (const m of serverModules()) if (m.retention) Object.assign(modules, await m.retention(now));
  const leases = await sql`DELETE FROM delivery_leases WHERE expires_at < ${now}`;
  // Scheduled-task history: 30 days (failures 90) is enough for the runs view.
  const runs = await sql`DELETE FROM job_runs WHERE started_at < ${new Date(now.getTime() - 30 * 86400_000)} AND (status IS DISTINCT FROM 'failed' OR started_at < ${new Date(now.getTime() - 90 * 86400_000)})`;
  const monthMs = 30 * 86400_000;
  // Feedback screenshots that only wait to be forwarded (the database then keeps just the Feishu image
  // key). The forwarding sweep gives up after a week; anything older is removed, whether or not
  // forwarding ever ran for it. Without the internal chat they are the screenshots themselves and stay.
  const deletedScreenshots = screenshotsForwarded() ? await removeOlderThan(path.join(config.dataDir, "feedback-screenshots"), 8 * 86400_000, now.getTime()) : 0;
  // Derived caches (proxied images, share cards and posters) are rebuilt on demand.
  const prunedCache = (await removeOlderThan(path.join(config.dataDir, "imgcache"), monthMs, now.getTime())) + (await removeOlderThan(path.join(config.dataDir, "ogcache"), monthMs, now.getTime()));
  return {
    ...modules,
    deletedLeases: leases.count,
    deletedJobRuns: runs.count,
    deletedScreenshots,
    prunedCache,
  };
}
