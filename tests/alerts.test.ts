// Ops alerts reach the site's operators: a problem is announced once, repeated no more than its level
// allows (hourly for reader impact), closed with one recovery message.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { checkAlerts, collectFindings, sendDigest } from "@aihot/backend/operations/alerts";
import { runsOverview } from "@aihot/backend/admin/runs";

process.env.COLLECT_ENABLED = "false";
process.env.MODEL_CALLS_ENABLED = "false";

const T = tag();
const SOURCE = `test-alerts-${T}`;
const stuckIds: string[] = [];
before(async () => {
  await getBoss(); // collectFindings reads the job tables
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test alerts', 'rss', '2100-01-01')`;
  // Ten new articles that have waited three hours: new content is stuck, readers see nothing new.
  for (let i = 0; i < 10; i++) {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-${i}`, title: `stuck ${i}`, bodyStatus: "none", via: "fetch" });
    stuckIds.push(articleId);
  }
  await sql`UPDATE articles SET discovered_at = now() - interval '3 hours', processing_state = 'new' WHERE id IN ${sql(stuckIds)}`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

test("an outage is announced once, repeated hourly, and closed with one recovery", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  try {
    const t0 = Date.now();
    const stuck = (sent: string[]) => sent.filter((k) => k.startsWith("content.process"));

    let r = await checkAlerts(t0);
    assert.deepEqual(stuck(r.sent), ["content.process"]);
    r = await checkAlerts(t0 + 50 * 60_000);
    assert.deepEqual(stuck(r.sent), [], "no repeat within the hour");
    r = await checkAlerts(t0 + 61 * 60_000);
    assert.deepEqual(stuck(r.sent), ["content.process"], "hourly reminder while it lasts");

    await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id IN ${sql(stuckIds)}`;
    r = await checkAlerts(t0 + 70 * 60_000);
    assert.deepEqual(stuck(r.sent), ["content.process:recovered"]);
    r = await checkAlerts(t0 + 80 * 60_000);
    assert.deepEqual(stuck(r.sent), []);
  } finally {
    process.env.COLLECT_ENABLED = "false";
    process.env.MODEL_CALLS_ENABLED = "false";
  }
});

// Backup failures may overwrite the latest-attempt summary. Alert age must use the last successful
// run; repeated failures must not reset it. With no success ever, age starts at the first attempt.
test("backup failures still escalate after fifty hours without a success", async () => {
  Object.assign(process.env, {
    DB_BACKUP_STORE_SECRET_ID: "test-backup-key", DB_BACKUP_STORE_SECRET_KEY: "test-backup-secret",
    DB_BACKUP_STORE_BUCKET: "test-bucket", DB_BACKUP_STORE_REGION: "test-region",
  });
  const now = Date.now();
  const old = new Date(now - 51 * 3600_000);
  try {
    await sql`INSERT INTO settings (key, value) VALUES ('backup.last', ${sql.json({ at: new Date(now).toISOString(), uploaded: false, filesError: "tar failed" })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await sql`INSERT INTO job_runs (job, started_at, finished_at, status) VALUES ('ops.backup', ${old}, ${old}, 'ok')`;
    await sql`INSERT INTO job_runs (job, started_at, finished_at, status) VALUES ('ops.backup', ${new Date(now)}, ${new Date(now)}, 'failed')`;
    const backup = async () => (await collectFindings(now)).filter((f) => f.key.startsWith("backup."));
    assert.equal((await backup())[0]?.level, "today", "the fresh failed attempt must not hide a stale successful backup");
    await sql`DELETE FROM job_runs WHERE job = 'ops.backup'`;
    await sql`INSERT INTO job_runs (job, started_at, finished_at, status) VALUES ('ops.backup', ${old}, ${old}, 'failed')`;
    await sql`DELETE FROM settings WHERE key = 'backup.last'`;
    assert.equal((await backup())[0]?.level, "today", "never-successful backups must also escalate");
    await sql`UPDATE job_runs SET started_at = ${new Date(now)}, finished_at = ${new Date(now)} WHERE job = 'ops.backup'`;
    assert.equal((await backup())[0]?.level, "later", "a first failed attempt does not claim two days of failure");
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("DB_BACKUP_STORE_")) delete process.env[key];
  }
});

// Failure cases: scoring succeeded but identity work failed outside processing_state; a short normal
// wait creates noise; withdrawn/rejected/completed items stay counted; unknown paid work is called
// harmless or automatically recoverable after its one automatic release has already been used;
// a successful repair leaves an alert open; the runs page cannot identify the affected news;
// a new material revision inherits the original candidate's old timestamp and immediately alerts.
test("selected identity delays show reader impact, recovery state and the affected articles", async () => {
  const now = Date.now();
  const source = "grouping-alert-source";
  const make = async (id: string, age: number, state: "pending" | "failed" | "complete", candidate = true, visibility = "public") => {
    const at = new Date(now - age * 60_000);
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,grouping_status,grouping_error)
      VALUES(${id},${source},${id},${`https://example.com/${id}`},${id},${at},${at},${at},${state},${state === "failed" ? "identity provider timed out" : null})`;
    await sql`INSERT INTO publications(article_id,source_id,title,summary,eligible,selected,selection_candidate,visibility,
      selected_ready_at,discovered_at,timeline_at,sort_at,url,category,channel)
      VALUES(${id},${source},${`新闻 ${id}`},'摘要',true,false,${candidate},${visibility},${at},${at},${at},${at},${`https://example.com/${id}`},'industry','news')`;
  };
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  try {
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},'Grouping alerts','rss','T1','editorial')`;
    await make("group-alert-brief", 2, "pending");
    await make("group-alert-revision", 48 * 60, "pending");
    await sql`INSERT INTO article_revisions(article_id,revision,title,created_at)
      VALUES('group-alert-revision',1,'current material revision',${new Date(now)})`;
    await make("group-alert-done", 30, "complete");
    await make("group-alert-rejected", 30, "failed", false);
    await make("group-alert-withdrawn", 30, "failed", true, "withdrawn");
    const finding = async () => (await collectFindings(now)).find((f) => f.key === "content.grouping");
    assert.equal(await finding(), undefined, "normal waits and content no longer eligible do not alert");

    await make("group-alert-failed", 20, "failed");
    let warning = await finding();
    assert.equal(warning?.level, "now");
    assert.match(warning!.impact!, /1 条.*精选/);
    assert.match(warning!.heals!, /人工|处理后/);
    assert.match(warning!.detail!, /group-alert-failed/);
    const runs = await runsOverview();
    assert.equal(runs.grouping.waiting, 3, "the runs page includes normal waits but no false candidates");
    assert.equal(runs.grouping.needsAttention, 1);
    assert.ok(runs.grouping.items.some((item) => item.articleId === "group-alert-failed" && item.recovery === "manual"));

    const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status)
      VALUES('group-alert-receipt','deepseek','event_identity','article:group-alert-failed','unknown') RETURNING id`;
    await sql`UPDATE articles SET grouping_receipt_id=${receipt!.id} WHERE id='group-alert-failed'`;
    warning = await finding();
    assert.match(warning!.heals!, /自动/);
    assert.match(warning!.heals!, /30 分钟/);
    await sql`INSERT INTO receipt_attempts(receipt_id,service,attempt,status,error)
      VALUES(${receipt!.id},'deepseek',1,'failed','自动放行：结果未知超过 30 分钟，未核对是否计费')`;
    warning = await finding();
    assert.match(warning!.heals!, /人工|处理后/);
    assert.match(warning!.detail!, new RegExp(`#${receipt!.id}`));

    await sql`UPDATE articles SET grouping_status='complete',grouped_at=now(),grouping_receipt_id=NULL WHERE id='group-alert-failed'`;
    assert.equal(await finding(), undefined, "successful identity repair clears the reader-impact finding");
    assert.equal((await runsOverview()).grouping.needsAttention, 0);
  } finally {
    process.env.COLLECT_ENABLED = "false";
    process.env.MODEL_CALLS_ENABLED = "false";
    await sql`DELETE FROM publications WHERE source_id=${source}`;
    await sql`DELETE FROM articles WHERE source_id=${source}`;
    await sql`DELETE FROM sources WHERE id=${source}`;
    await sql`DELETE FROM receipt_attempts WHERE receipt_id IN (SELECT id FROM receipts WHERE logical_key='group-alert-receipt')`;
    await sql`DELETE FROM receipts WHERE logical_key='group-alert-receipt'`;
  }
});

test("the ops digest does not describe unknown paid work as harmless or already retried", async () => {
  const lines: string[] = [];
  const log = console.log;
  const enabled = process.env.FEISHU_INTERNAL_ENABLED;
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  try {
    await sql`INSERT INTO receipts(logical_key,service,purpose,status) VALUES('digest-unknown-impact','deepseek','event_identity','unknown')`;
    console.log = (value: unknown) => { lines.push(String(value)); };
    await sendDigest();
    const message = lines.join("\n");
    assert.match(message, /结果.*未知|结果.*确认/);
    assert.doesNotMatch(message, /以下事项不影响读者|自动重试过一次/);
  } finally {
    console.log = log;
    if (enabled === undefined) delete process.env.FEISHU_INTERNAL_ENABLED;
    else process.env.FEISHU_INTERNAL_ENABLED = enabled;
  }
});
