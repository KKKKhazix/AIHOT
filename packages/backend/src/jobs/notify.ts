// Content pushes: selected items after their release gate, and the images they need prepared first.
import type { PgBoss } from "pg-boss";
import { pushSelected } from "../notify/selected.ts";
import { prepareArticleMedia, warmShareImage } from "../media/prepare.ts";
import { convertAnimated } from "../media/images.ts";
import { enqueue, QUEUES, work } from "./queue.ts";

const MAX_RETRIES = 6;

export async function registerNotifyJobs(boss: PgBoss) {
  await work(boss, QUEUES.notifySelected, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async ({ articleId, attempt = 0 }) => {
    // The push makes chat apps unfurl the link: have its share image ready (first attempt only).
    if (!attempt) await warmShareImage(articleId);
    const outcome = await pushSelected(articleId);
    if (outcome.status === "retry" && attempt < MAX_RETRIES) {
      await enqueue(QUEUES.notifySelected, { articleId, attempt: attempt + 1 }, { startAfter: outcome.after });
    }
    return outcome;
  });

  await work(boss, QUEUES.prepareMedia, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async (data) =>
    "articleId" in data ? prepareArticleMedia(data.articleId) : { animatedSaved: await convertAnimated(data.url, data.mode) });
}
