import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { beijingAt } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { checkAlerts, collectFindings } from "@aihot/backend/operations/alerts";

const at = (date: string, time = "10:00") => beijingAt(date, time).getTime();
const key = (date: string) => `report.daily:${date}`;
const daily = (keys: string[]) => keys.filter(k => k.startsWith("report.daily"));
async function report(date: string) {
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily',${date},${new Date(at(date))},${new Date(at(date))},'{}',${new Date(at(date))})`;
}
before(async () => { await getBoss(); });
beforeEach(async () => {
  Object.assign(process.env, { COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true", FEISHU_INTERNAL_ENABLED: "false" });
  await sql`DELETE FROM reports`;
  await sql`DELETE FROM job_runs WHERE job='reports.compose'`;
  await sql`DELETE FROM settings WHERE key IN ('alerts.state','heartbeat.worker')`;
});
after(async () => { await stopBoss(); await closeDb(); });

test("midnight preserves a missing edition; each date recovers only when its report exists", async () => {
  let result = await checkAlerts(at("2026-10-06", "23:30"));
  assert.deepEqual(daily(result.sent), [key("2026-10-06")]);
  result = await checkAlerts(at("2026-10-07", "00:10"));
  assert.deepEqual(daily(result.open), [key("2026-10-06")]);
  assert.deepEqual(daily(result.sent), []);
  result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(daily(result.open).sort(), [key("2026-10-06"), key("2026-10-07")]);
  await report("2026-10-07");
  result = await checkAlerts(at("2026-10-07", "10:10"));
  assert.deepEqual(daily(result.sent), [`${key("2026-10-07")}:recovered`]);
  assert.deepEqual(daily(result.open), [key("2026-10-06")]);
  await report("2026-10-06");
  assert.deepEqual(daily((await checkAlerts(at("2026-10-07", "10:20"))).sent), [`${key("2026-10-06")}:recovered`]);
  assert.deepEqual(daily((await checkAlerts(at("2026-10-07", "10:30"))).sent), []);
});

test("recent gap detection uses report activity and each edition's overdue time", async () => {
  await sql`INSERT INTO job_runs(job,started_at,status) VALUES('reports.compose',${new Date(at("2026-10-05"))},'failed')`;
  await report("2026-10-06");
  const findings = await collectFindings(at("2026-10-07", "09:59"));
  assert.deepEqual(daily(findings.map(f => f.key)), [key("2026-10-05")]);
  await report("2026-09-01");
  assert.deepEqual(daily((await collectFindings(at("2026-10-07"))).map(f => f.key)),
    [1,2,3,4,5,7].map(d => key(`2026-10-0${d}`)));
});

test("open dates outlive disabled generation or startup grace within the scan window", async () => {
  await checkAlerts(at("2026-10-01"));
  process.env.MODEL_CALLS_ENABLED = "false";
  let result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(daily(result.open), [key("2026-10-01")]);
  assert.deepEqual(daily(result.sent), []);
  process.env.MODEL_CALLS_ENABLED = "true";
  await sql`INSERT INTO settings(key,value) VALUES('heartbeat.worker',${sql.json({ startedAt: new Date(at("2026-10-07")).toISOString() })})`;
  assert.deepEqual(daily((await checkAlerts(at("2026-10-07"))).open), [key("2026-10-01")]);
  await sql`DELETE FROM settings WHERE key='heartbeat.worker'`;
  result = await checkAlerts(at("2026-10-07"));
  assert.ok(result.sent.includes(key("2026-10-01")), "an unresolved edition in the window still gets reminders");
  process.env.COLLECT_ENABLED = "false";
  await report("2026-10-01");
  assert.ok((await checkAlerts(at("2026-10-07", "10:10"))).sent.includes(`${key("2026-10-01")}:recovered`));
});

test("an edition still missing past the scan window is closed once instead of reminded forever", async () => {
  await checkAlerts(at("2026-10-01"));
  let result = await checkAlerts(at("2026-10-08"));
  assert.ok(result.sent.includes(`${key("2026-10-01")}:expired`));
  assert.ok(!result.open.includes(key("2026-10-01")));
  result = await checkAlerts(at("2026-10-08", "12:00"));
  assert.ok(!result.sent.some(k => k.startsWith(key("2026-10-01"))));
});

test("legacy alert migrates its date and preserves reminder timing", async () => {
  const since = new Date(at("2026-10-06", "23:30")).toISOString();
  await sql`INSERT INTO settings(key,value) VALUES('alerts.state',${sql.json({ "report.daily": { title: "今天的日报还没生成", since, sentAt: since } })})`;
  let result = await checkAlerts(at("2026-10-07", "00:10"));
  assert.deepEqual(daily(result.open), [key("2026-10-06")]);
  assert.deepEqual(daily(result.sent), []);
  result = await checkAlerts(at("2026-10-07", "00:31"));
  assert.deepEqual(daily(result.sent), [key("2026-10-06")]);
});
