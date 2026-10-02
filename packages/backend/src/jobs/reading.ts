import type { PgBoss } from "pg-boss";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { readArticle, readingImages } from "../content/reading.ts";
import { bodyReadingMode, readingConcurrency } from "../content/reading-config.ts";
import { ReceiptUnknownError } from "../providers/receipts.ts";
import { work, QUEUES } from "./queue.ts";
import { afterFailure, queueProcessing } from "./content.ts";

export async function processReading(articleId: string, opts: { silent?: boolean; requestKey?: string; mode?: "shadow" | "active" } = {}) {
  if (bodyReadingMode() === "off" || !config.modelCallsEnabled) return { state: "disabled" };
  const shadow = opts.mode === "shadow" || bodyReadingMode() === "shadow";
  const [started] = await sql<{ revision: number; generation: number }[]>`SELECT revision, reading_generation AS generation FROM articles WHERE id = ${articleId}`;
  if (!started) return { state: "missing" };
  try {
    const result = await readArticle(articleId, opts);
    if (result.activated) {
      await queueProcessing(articleId, { step: "analyze" });
      return { state: "read", readingId: result.reading?.id };
    }
    if (shadow) return { state: "shadow", readingId: result.reading?.id };
    if (result.stale) { await queueProcessing(articleId); return { state: "stale" }; }
    if (result.reading) {
      if ((await readingImages(result.reading.id)).some((i) => i.status === "unreadable" && i.retryable)) {
        return afterFailure(articleId, new Error("部分图片暂时下载失败，稍后只重试未完成图片"), { revision: result.reading.input_revision, generation: result.reading.generation });
      }
      await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${result.reading.error ?? "正文需要核对"}, processing_queued_at = NULL
        WHERE id = ${articleId} AND revision = ${result.reading.input_revision} AND reading_generation = ${result.reading.generation}`;
    }
    return { state: "needs-review", readingId: result.reading?.id };
  } catch (error) {
    // A job queued for comparison stays isolated even if deployment switches to active.
    if (shadow) throw error;
    if (error instanceof ReceiptUnknownError) {
      await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${`receipt ${error.receiptId} outcome unknown`} WHERE id = ${articleId}
        AND revision = ${started?.revision ?? -1} AND reading_generation = ${started?.generation ?? -1}`;
      return { state: "unknown-receipt" };
    }
    return afterFailure(articleId, error, started);
  }
}

export async function registerReadingJobs(boss: PgBoss) {
  await work(boss, QUEUES.readBody, { localConcurrency: readingConcurrency(), pollingIntervalSeconds: 2 },
    ({ articleId, ...opts }) => processReading(articleId, opts));
}
