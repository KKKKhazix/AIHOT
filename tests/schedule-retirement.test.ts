// Retirement failures: old schedules keep producing work, already-unscheduled queues keep old jobs,
// cleanup removes a live/business queue or its durable run history, or retired failures stay in the
// admin's current schedules. Use pg-boss and PostgreSQL.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { runsOverview } from "@aihot/backend/admin/runs";
import { registerSchedules } from "../apps/worker/src/schedules.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("retired schedules leave the current overview and execution queues while live jobs and history remain", async () => {
  let externalJobs = ["external.kept", "kept", "external.kept"];
  const boss = await getBoss();
  const retired = ["cron.retired.scheduled", "cron.retired.unscheduled", "cron.paused", "cron.renamed.old"];
  for (const name of [...retired, "cron.kept", "cron.renamed.new", "business.kept"]) {
    await boss.createQueue(name);
    await boss.send(name, { fixture: true }, { startAfter: "2099-01-01" });
  }
  for (const name of [retired[0]!, "cron.paused", "cron.renamed.old"]) await boss.schedule(name, "0 0 1 1 *");
  for (const name of retired) {
    await sql`INSERT INTO job_runs (job, status, finished_at) VALUES (${name.slice("cron.".length)}, 'failed', now())`;
  }
  await sql`INSERT INTO job_runs (job, started_at, finished_at, status) VALUES
    ('kept', now() - interval '2 days', now() - interval '2 days', 'failed'),
    ('renamed.new', now() - interval '1 hour', now() - interval '1 hour', 'failed'),
    ('renamed.new', now(), now(), 'ok')`;
  await sql`INSERT INTO job_runs (job, status, finished_at) VALUES
    ('external.kept', 'failed', now()), ('external.retired', 'failed', now())`;
  installModules([{ name: "test", schedules: [
    { name: "kept", cron: "0 0 1 1 *", run: async () => ({}) },
    { name: "renamed.new", cron: "0 0 1 1 *", run: async () => ({}) },
    { name: "paused", cron: "0 0 1 1 *", when: () => false, run: async () => ({}) },
  ], admin: { currentJobs: async () => externalJobs } }]);

  await registerSchedules(boss);
  // Multiple schedule keys must still yield one latest result per task.
  await boss.schedule("cron.kept", "0 0 1 1 *", {}, { key: "extra" });
  const schedules = await boss.getSchedules();
  for (const name of retired) {
    assert.ok(!schedules.some((s) => s.name === name));
    assert.equal(await boss.getQueue(name), null, `${name} leaves no execution queue`);
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${name}`).length, 0);
  }
  for (const name of ["cron.kept", "cron.renamed.new"]) assert.ok(schedules.some((s) => s.name === name));
  for (const name of ["cron.kept", "cron.renamed.new", "business.kept"]) {
    assert.ok(await boss.getQueue(name));
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${name}`).length, 1);
  }
  // An engine timer may also finish during this test; its result must not affect the fixture checks.
  await sql`INSERT INTO job_runs (job, status, finished_at) VALUES ('hot.rank', 'failed', now())`;
  const overview = await runsOverview();
  const fixtureNames = new Set([...retired, "cron.kept", "cron.renamed.new"].map((name) => name.slice("cron.".length)));
  const jobs = overview.jobs.filter((j) => fixtureNames.has(j.job));
  assert.deepEqual(jobs.map((j) => j.job), ["kept", "renamed.new"]);
  assert.deepEqual(jobs.filter((j) => j.status === "failed").map((j) => j.job), ["kept"]);
  assert.deepEqual(jobs.map((j) => [j.failed_24h, j.runs_24h]), [[0, 0], [1, 2]]);
  assert.deepEqual(overview.jobs.filter((j) => j.job.startsWith("external.")).map((j) => [j.job, j.status, j.failed_24h, j.runs_24h]),
    [["external.kept", "failed", 1, 1]]);
  for (const job of ["external.kept", "external.retired"]) assert.ok(overview.timeline.some((r) => r.job === job));
  externalJobs = [];
  const withdrawn = await runsOverview();
  assert.ok(!withdrawn.jobs.some((j) => j.job.startsWith("external.")));
  assert.ok(withdrawn.timeline.some((r) => r.job === "external.kept"));
  assert.equal((await sql`SELECT id FROM job_runs WHERE job = 'external.kept'`).length, 1);
  for (const name of retired) {
    const job = name.slice("cron.".length);
    assert.equal((await sql`SELECT id FROM job_runs WHERE job = ${job}`).length, 1);
    assert.ok(overview.timeline.some((r) => r.job === job && r.status === "failed"));
  }
});
