// Collection jobs: per-source fetch runs and body extraction before analysis.
import type { PgBoss } from "pg-boss";
import { dajialaConfigured } from "../providers/dajiala.ts";
import { collectSource, collectXShard } from "../sources/collect.ts";
import { checkMpAccount } from "../sources/mp.ts";
import { QUEUES, work } from "./queue.ts";
import { registerExtractionJobs } from "./content.ts";

export async function registerSourceJobs(boss: PgBoss) {
  await work(boss, QUEUES.fetchSource, { localConcurrency: 8, pollingIntervalSeconds: 2 }, ({ sourceId, force }) => collectSource(sourceId, { force }));
  // One search per shard of X accounts; every SocialData caller shares its per-minute budget.
  await work(boss, QUEUES.fetchXShard, { localConcurrency: 2, pollingIntervalSeconds: 2 }, ({ key, sourceIds }) => collectXShard(key, sourceIds));
  // WeChat accounts through Dajiala, only when it is configured (as their scheduled checks); it allows a
  // few requests per second, and two accounts at a time stays well under it.
  if (dajialaConfigured()) await work(boss, QUEUES.mpCheck, { localConcurrency: 2, pollingIntervalSeconds: 2 }, ({ sourceId, reason }) => checkMpAccount(sourceId, reason ?? "schedule"));
  await registerExtractionJobs(boss);
}
