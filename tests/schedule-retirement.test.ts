// Retirement failures: old schedules keep producing work, already-unscheduled queues keep old jobs,
// or cleanup removes a live/business queue or its durable run history. Use pg-boss and PostgreSQL.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { registerSchedules } from "../apps/worker/src/schedules.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("retired schedules remove their execution queues while live jobs and run history remain", async () => {
  const boss = await getBoss();
  const retired = ["cron.retired.scheduled", "cron.retired.unscheduled", "cron.paused"];
  for (const name of [...retired, "cron.kept", "business.kept"]) {
    await boss.createQueue(name);
    await boss.send(name, { fixture: true }, { startAfter: "2099-01-01" });
  }
  await boss.schedule(retired[0]!, "0 0 1 1 *");
  await boss.schedule("cron.paused", "0 0 1 1 *");
  await sql`INSERT INTO job_runs (job, status, finished_at) VALUES ('retired.scheduled', 'ok', now())`;
  installModules([{ name: "test", schedules: [
    { name: "kept", cron: "0 0 1 1 *", run: async () => ({}) },
    { name: "paused", cron: "0 0 1 1 *", when: () => false, run: async () => ({}) },
  ] }]);

  await registerSchedules(boss);
  const schedules = await boss.getSchedules();
  for (const name of retired) {
    assert.ok(!schedules.some((s) => s.name === name));
    assert.equal(await boss.getQueue(name), null, `${name} leaves no execution queue`);
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${name}`).length, 0);
  }
  assert.ok(schedules.some((s) => s.name === "cron.kept"));
  for (const name of ["cron.kept", "business.kept"]) {
    assert.ok(await boss.getQueue(name));
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${name}`).length, 1);
  }
  assert.equal((await sql`SELECT id FROM job_runs WHERE job = 'retired.scheduled'`).length, 1);
});
