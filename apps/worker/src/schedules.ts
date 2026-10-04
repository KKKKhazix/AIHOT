// Cron-style schedules (Asia/Shanghai), the engine's and then the site's modules'. Each run is recorded in
// job_runs; missed slots run once.
import type { PgBoss } from "pg-boss";
import { ensureQueue, recordRun } from "@aihot/backend/jobs/queue";
import { serverModules, type Scheduled } from "@aihot/backend/modules";
import { sweepUnprocessed } from "@aihot/backend/jobs/content";
import { translatePending } from "@aihot/backend/editorial/translate";
import { adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { dajialaConfigured } from "@aihot/backend/providers/dajiala";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { linkRelatedStories } from "@aihot/backend/events/consolidate";
import { composeDueReports } from "@aihot/backend/reports/compose";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { submitIndexNow } from "@aihot/backend/operations/indexnow";
import { checkAlerts, sendDigest } from "@aihot/backend/operations/alerts";
import { recoverStaleWork } from "@aihot/backend/operations/recover";
import { forwardPendingFeedback } from "@aihot/backend/operations/feedback";
import { backupConfigured, runBackup } from "@aihot/backend/operations/backup";
import { sourceHealthWeekly } from "@aihot/backend/operations/reports";

const collecting = process.env.COLLECT_ENABLED === "true";

const ENGINE_SCHEDULES: Scheduled[] = [
  { name: "content.sweep", cron: "*/5 * * * *", run: sweepUnprocessed },
  // Full-text translations of newly selected items (model calls; off with MODEL_CALLS_ENABLED=false).
  { name: "content.translate", cron: "*/5 * * * *", run: () => translatePending() },
  { name: "hot.rank", cron: "*/5 * * * *", run: () => computeHotRanking() },
  { name: "hot.snapshot", cron: "2 * * * *", run: () => snapshotHeat() },
  { name: "stories.links", cron: "12 * * * *", run: linkRelatedStories },
  // Every issue that is due and not written yet, each from its edition time (site/site.ts EDITION_TIMES)
  // at the next half hour; a missed or failed one at the next run.
  { name: "reports.compose", cron: "0,30 * * * *", missed: "once", run: () => composeDueReports() },
  // The deletions the privacy notice promises, once their retention periods are over.
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", run: () => dailyRetention() },
  // IndexNow for new indexable pages (off unless INDEXNOW_SUBMIT_ENABLED).
  { name: "seo.indexnow", cron: "50 5 * * *", missed: "once", run: () => submitIndexNow() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release; ops.alerts runs in parallel and sees the result by its next run at the latest.
  { name: "ops.recover", cron: "*/10 * * * *", run: () => recoverStaleWork() },
  { name: "ops.alerts", cron: "*/10 * * * *", run: () => checkAlerts() },
  // One message with other follow-ups and their actual impact (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", run: () => sourceHealthWeekly() },
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources() },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        // Icons are read from the sources' own sites, so they stop with collection.
        { name: "sources.icons", cron: "40 4 * * *", missed: "once" as const, run: () => refreshSourceIcons() },
      ]
    : []),
  // WeChat official accounts through Dajiala (paid), each once per its interval; only with its key.
  ...(collecting && dajialaConfigured() ? [{ name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() }] : []),
];

export async function registerSchedules(boss: PgBoss) {
  const schedules = [...ENGINE_SCHEDULES, ...serverModules().flatMap((m) => m.schedules ?? []).filter((s) => s.when?.() ?? true)];
  for (const s of schedules) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
    await boss.schedule(queue, s.cron, {}, { tz: "Asia/Shanghai", missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    await boss.work(queue, { pollingIntervalSeconds: 15 }, async () => recordRun(s.name, s.run));
  }
  // Retired or disabled timers must leave no queued work behind, including queues an earlier release
  // already unscheduled. pg-boss deletes the queue's jobs and schedules; job_runs retains its audit.
  const current = new Set(schedules.map((s) => `cron.${s.name}`));
  for (const old of await boss.getQueues()) {
    if (old.name.startsWith("cron.") && !current.has(old.name)) await boss.deleteQueue(old.name);
  }
}
