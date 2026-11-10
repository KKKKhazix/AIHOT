import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { getBoss, enqueue, QUEUES, recordRun, stopBoss } from "@aihot/backend/jobs/queue";

import { closeDb, sql } from "@aihot/backend/db";
import { closeInterruptedRuns, runOwner } from "@aihot/backend/jobs/runs";

after(async () => { await stopBoss(); await closeDb(); });

test("an array-valued schedule result keeps its owner without adding a false result row", async () => {
  const job = `balances-${tag()}`;
  const result = [{ service: "provider", balance: 100, ok: true, low: false }];
  assert.deepEqual(await recordRun(job, async () => result), result);
  const [row] = await sql`SELECT status,detail FROM job_runs WHERE job=${job}`;
  assert.equal(row!.status, "ok");
  assert.deepEqual(row!.detail, { result, owner: await runOwner() });
});

test("recovery closes a killed process's runs, preserves live and foreign owners and retains evidence", { skip: !["linux", "darwin"].includes(process.platform) }, async (t) => {
  const timezone = process.env.TZ;
  process.env.TZ = "Pacific/Honolulu";
  t.after(() => { if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone; });
  const id = `owner-${tag()}`;
  const server = http.createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${id},${id},'rss',${sql.json({ feedUrl: `http://127.0.0.1:${port}/feed` })})`;
  const script = `
    import { config } from '@aihot/backend/config';
    import { sql } from '@aihot/backend/db';
    import { recordRun } from '@aihot/backend/jobs/queue';
    import { collectSource } from '@aihot/backend/sources/collect';
    config.allowPrivateNetworkFetch = true;
    const id = process.argv[1];
    const pending = recordRun(id, () => collectSource(id));
    const check = setInterval(async () => {
      const rows = await sql\`SELECT id FROM fetch_runs WHERE source_id = \${id}\`;
      if (rows.length) { clearInterval(check); process.send('started'); }
    }, 10);
    await pending;
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, id], { env: { ...process.env, TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", data => { stderr += data; });
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`owner child exited: ${stderr}`); })]);
    const [running] = await sql`SELECT detail FROM job_runs WHERE job = ${id}`;
    assert.equal(running!.detail.owner.pid, child.pid);
    assert.equal(running!.detail.owner.host, (await runOwner()).host);
    await closeInterruptedRuns();
    assert.equal((await sql`SELECT status FROM job_runs WHERE job=${id}`)[0]!.status, "running");
    assert.equal((await sql`SELECT status FROM fetch_runs WHERE source_id=${id}`)[0]!.status, "running");
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    const owner = await runOwner();
    const [foreign] = await sql`INSERT INTO job_runs(job,detail) VALUES(${id + "-foreign"},${sql.json({ owner: { ...owner, host: "another-host" } })}) RETURNING id`;
    const [unknown] = await sql`INSERT INTO job_runs(job) VALUES(${id + "-unknown"}) RETURNING id`;
    const [reused] = await sql`INSERT INTO job_runs(job,detail) VALUES(${id + "-reused"},${sql.json({ owner: { ...owner, birth: "previous-process" } })}) RETURNING id`;
    const [finished] = await sql`INSERT INTO job_runs(job,status,finished_at,detail) VALUES(${id + "-done"},'ok',now(),${sql.json(running!.detail)}) RETURNING id`;
    assert.deepEqual(await closeInterruptedRuns(), { jobs: 2, fetches: 1 });
    for (const table of ["job_runs", "fetch_runs"]) {
      const rows = await sql`SELECT * FROM ${sql(table)} WHERE ${table === "job_runs" ? sql`job = ${id}` : sql`source_id = ${id}`}`;
      assert.equal(rows[0]!.status, "skipped");
      assert.ok(rows[0]!.finished_at);
      assert.equal(rows[0]!.detail.owner.pid, child.pid);
      const [audit] = await sql`SELECT before,after FROM audit_log WHERE action='run.interrupted' AND subject=${`${table}:${rows[0]!.id}`}`;
      assert.equal(audit!.before.status, "running");
      assert.equal(audit!.after.status, "skipped");
      assert.equal(audit!.before.detail.owner.pid, child.pid);
    }
    const unchanged = await sql`SELECT id,status FROM job_runs WHERE id IN ${sql([foreign!.id,unknown!.id,reused!.id,finished!.id])} ORDER BY id`;
    assert.deepEqual(unchanged.map(row => row.status), ["running", "running", "skipped", "ok"]);
    assert.deepEqual(await closeInterruptedRuns(), { jobs: 0, fetches: 0 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child,"exit"); child.kill("SIGKILL"); await exit; }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a failed first database connection does not poison all later queue requests", async () => {
  const original = config.databaseUrl;
  const missing = new URL(original);
  missing.pathname = "/aihot_missing_queue_recovery_test";
  config.databaseUrl = missing.toString();
  try {
    await assert.rejects(getBoss(), /does not exist/);
  } finally {
    config.databaseUrl = original;
  }
  const boss = await getBoss();
  const id = await enqueue(QUEUES.analyze, { articleId: "recovered" });
  assert.ok(id);
  assert.equal((await boss.getJobById<{ articleId: string }>(QUEUES.analyze, id))?.data.articleId, "recovered");
});

// API or inspection clients must not steal cron forwarding; only the designated worker dispatches.
test('ordinary clients leave timer dispatch to the designated worker', async () => {
  const boss = await getBoss();
  await boss.createQueue('ownership.target');
  await boss.createQueue('__pgboss__send-it');
  const id = await boss.send('__pgboss__send-it', { name: 'ownership.target', key: '', data: {}, options: {} });
  assert.ok(id);
  await new Promise(resolve => setTimeout(resolve, 6500));
  assert.equal((await sql`SELECT state FROM pgboss.job WHERE id=${id}`)[0]!.state, 'created');
  assert.equal((await sql`SELECT count(*)::int AS count FROM pgboss.job WHERE name='ownership.target'`)[0]!.count, 0);
  await stopBoss();
  await getBoss({ supervise: true });
  const deadline = Date.now() + 12000;
  while ((await sql`SELECT count(*)::int AS count FROM pgboss.job WHERE name='ownership.target'`)[0]!.count === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await sql`SELECT count(*)::int AS count FROM pgboss.job WHERE name='ownership.target'`)[0]!.count, 1);
});
