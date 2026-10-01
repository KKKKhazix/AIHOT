// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { settleNonEditorial } from "./content.ts";
import { enqueue, QUEUES, work } from "./queue.ts";

export async function registerEventJobs(boss: PgBoss) {
  // Serial on purpose: two reports of the same new fact must not both create it.
  await work(boss, QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async ({ articleId, signalOnly, force }) => {
    // A discussion post comes here straight from collection: record it first (settleNonEditorial).
    if (signalOnly && !force && !(await settleNonEditorial(articleId)).group) return { verdict: "skipped" };
    const result = await groupArticle(articleId, { signalOnly, force });
    if (result.storyId && !result.verdict.startsWith("signal")) {
      await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
    }
    return result;
  });
  await work(boss, QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, ({ storyId, afterCorrection }) => composeStoryDigest(storyId, { afterCorrection }));
}
