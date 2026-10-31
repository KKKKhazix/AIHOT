// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { groupingPriority, settleNonEditorial } from "./content.ts";
import { enqueue, ensureQueue, QUEUES, work } from "./queue.ts";
import { sql } from "../db.ts";
import { isHistorical, newsCondition } from "../content/materials.ts";

export async function registerEventJobs(boss: PgBoss) {
  // Serial on purpose: two reports of the same new fact must not both create it.
  await work(boss, QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async (data) => {
    const { articleId, signalOnly, regroup } = data;
    // A discussion post comes here straight from collection: record it first (settleNonEditorial).
    if (signalOnly && !(await settleNonEditorial(articleId)).group) return { verdict: "skipped" };
    const result = await groupArticle(articleId, { signalOnly, regroup });
    if (result.storyId && !result.verdict.startsWith("signal")) {
      await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
    }
    return result;
  });
  await work(boss, QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, ({ storyId }) => composeStoryDigest(storyId));
}

/**
 * Material that needs grouping (needsGrouping: a passed report, a discussion post while it is news)
 * left pending without a job: a lost job, or a wait groupArticle leaves pending (budget, provider
 * outage, shutdown) that outlasted the job's retries. Terminal failures need a receipt release or an
 * explicit rerun.
 */
export async function sweepUngrouped(): Promise<{ enqueued: number }> {
  await ensureQueue(QUEUES.group);
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
      SELECT a.id, s.participation_mode, a.backfill, a.published_at, a.discovered_at FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE a.grouping_status = 'pending' AND a.created_at < now() - interval '3 minutes'
        AND (s.participation_mode = 'editorial' AND a.processing_state = 'analyzed' AND EXISTS (
              SELECT 1 FROM analyses an WHERE an.article_id = a.id AND an.input_revision = a.revision AND an.relevance = 'pass')
          OR s.participation_mode = 'hot_signal' AND a.processing_state = 'skipped' AND ${newsCondition})
        AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = ${QUEUES.group}
          AND j.data->>'articleId' = a.id AND j.state IN ('created', 'active', 'retry'))
      ORDER BY a.created_at LIMIT 100 FOR UPDATE OF a SKIP LOCKED`;
    let enqueued = 0;
    for (const row of rows) {
      const signal = row.participation_mode !== "editorial";
      const priority = groupingPriority({ signal, historical: isHistorical(row) });
      const data = signal ? { articleId: row.id, signalOnly: true } : { articleId: row.id };
      if (await enqueue(QUEUES.group, data, { singletonKey: row.id, priority }, tx)) enqueued += 1;
    }
    return { enqueued };
  });
}
