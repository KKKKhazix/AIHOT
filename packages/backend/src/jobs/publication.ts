// Publication jobs: re-deriving a whole source after an admin change.
import type { PgBoss } from "pg-boss";
import { sql } from "../db.ts";
import { republishSource } from "../publication/publish.ts";
import { computeHotRanking } from "../events/hot.ts";
import { QUEUES, work } from "./queue.ts";

export const republishKey = (sourceId: string) => `republish.source:${sourceId}`;

async function progress(sourceId: string, value: Record<string, unknown>) {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${republishKey(sourceId)}, ${sql.json(value as never)}, 'worker')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function registerPublicationJobs(boss: PgBoss) {
  await work(boss, QUEUES.republishSource, { localConcurrency: 1, pollingIntervalSeconds: 2 }, async ({ sourceId }) => {
    const startedAt = new Date().toISOString();
    await progress(sourceId, { status: "running", done: 0, total: null, startedAt });
    const result = await republishSource(sourceId, (done, total) => progress(sourceId, { status: "running", done, total, startedAt }));
    if (result.reduced > 0) {
      // The hot board may show one of the source's articles: re-rank now rather than within five minutes.
      await computeHotRanking();
    }
    await progress(sourceId, { status: "done", ...result, startedAt, finishedAt: new Date().toISOString() });
    return result;
  });
}
