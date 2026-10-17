// Ops alerts reach the site's operators: a problem is announced once, repeated no more than its level
// allows (hourly for reader impact), closed with one recovery message.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { checkAlerts, collectFindings, providerStops, sendDigest } from "@aihot/backend/operations/alerts";
import { CAPABILITIES, capabilities, invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";
import { installModules, serverModules } from "@aihot/backend/modules";
import { MODELS } from "@aihot/backend/providers/llm";
import { READER_WORDING } from "@aihot/industry/wording";
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
  // One left over from yesterday: it outlives this episode, so it must not be what dates it.
  const { articleId: straggler } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-old`, title: "stuck since yesterday", bodyStatus: "none", via: "fetch" });
  stuckIds.push(straggler);
  await sql`UPDATE articles SET discovered_at = now() - interval '3 hours', processing_state = 'new' WHERE id IN ${sql(stuckIds)}`;
  await sql`UPDATE articles SET discovered_at = now() - interval '40 hours' WHERE id = ${straggler}`;
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
    // The episode is dated from when it was first seen: the article left over from yesterday is a fact in
    // the detail, not the start of a backlog that built up in the last three hours.
    const [state] = await sql<{ value: Record<string, { since: string }> }[]>`SELECT value FROM settings WHERE key = 'alerts.state'`;
    assert.equal(Date.parse(state!.value["content.process"]!.since), t0, "the episode is not dated by the oldest waiting article");
    const finding = (await collectFindings(t0)).find((f) => f.key === "content.process")!;
    assert.match(finding.detail!, /最老的一篇 .* 收进/);
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
test("a service stopped for an exhausted account is reported at once, and its recovery closes it", async () => {
  process.env.COLLECT_ENABLED = "true";
  try {
    const key = `provider.quota.${MODELS[await modelFor("summarize")]!.service}`;
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${sql.json({ until })}, 'test')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    const finding = (await collectFindings(Date.now())).find((f) => f.key === key);
    assert.ok(finding, "the stop is reported without waiting for refused requests to add up");
    assert.equal(finding.owner, true, "only the owner can pay");
    assert.match(finding.title, /额度用尽/);
    assert.match(finding.detail!, /暂停调用至/);
    // The stop is a state, not an event: once it lapses the finding is gone and the alert closes itself.
    await sql`UPDATE settings SET value = jsonb_build_object('until', (now() - interval '1 minute')::text) WHERE key = ${key}`;
    assert.equal((await collectFindings(Date.now())).find((f) => f.key === key), undefined);
    await sql`DELETE FROM settings WHERE key = ${key}`;
  } finally {
    process.env.COLLECT_ENABLED = "false";
  }
});

test("a model service's outage names the steps that call it, not the wording step while the word list is empty", async () => {
  const service = MODELS[await modelFor("wording")]!.service;
  const wording = CAPABILITIES.wording.label.split("（")[0]!;
  const list = READER_WORDING as Array<readonly [RegExp, string]>;
  const kept = list.splice(0);
  try {
    assert.ok(!(await providerStops(service)).includes(wording), "nothing to look for: the step never calls a model");
    list.push([/禁用词/u, "换一个说法"]);
    assert.ok((await providerStops(service)).includes(wording));
  } finally {
    list.splice(0, list.length, ...kept);
  }
});

test("provider impacts follow the current model choice, including overrides, fallback and module steps", async () => {
  const env = process.env.SCORE_MODEL;
  const moduleEnv = process.env.ALERT_TEST_MODEL;
  const installed = serverModules();
  const stepEnvs = Object.fromEntries(Object.values(capabilities()).map((step) => [step.env, process.env[step.env]]));
  const label = CAPABILITIES.score.label.split("（")[0]!;
  const defaultService = MODELS[CAPABILITIES.score.default]!.service;
  const other = Object.keys(MODELS).find((key) => MODELS[key]!.service !== defaultService)!;
  const otherService = MODELS[other]!.service;
  const scoreOn = async (service: string) => (await providerStops(service)).includes(label);
  try {
    await sql`DELETE FROM settings WHERE key = 'models.score'`;
    invalidateModelCache();
    delete process.env.SCORE_MODEL;
    assert.equal(await scoreOn(defaultService), true, "the code default is used without overrides");
    process.env.SCORE_MODEL = other;
    assert.equal(await modelFor("score"), other);
    assert.equal(await scoreOn(defaultService), false, "the old provider no longer lists scoring");
    assert.equal(await scoreOn(otherService), true, "the environment-selected provider lists scoring");

    await sql`INSERT INTO settings(key,value) VALUES ('models.score', ${sql.json({ model: CAPABILITIES.score.default })})`;
    invalidateModelCache();
    assert.equal(await scoreOn(defaultService), true, "the admin choice takes precedence over the environment");
    assert.equal(await scoreOn(otherService), false);
    await sql`UPDATE settings SET value = ${sql.json({ model: "unknown-model" })} WHERE key = 'models.score'`;
    invalidateModelCache();
    assert.equal(await scoreOn(otherService), true, "an invalid admin choice yields to a valid environment choice");
    process.env.SCORE_MODEL = "unknown-model";
    assert.equal(await modelFor("score"), CAPABILITIES.score.default);
    assert.equal(await scoreOn(defaultService), true, "an invalid environment choice falls back to the default");

    installModules([...installed, { name: "alert-test", models: { alertTest: { label: "模块测试步骤（说明）", env: "ALERT_TEST_MODEL", purposes: [] } } }]);
    process.env.ALERT_TEST_MODEL = other;
    assert.ok((await providerStops(otherService)).includes("模块测试步骤"));
    await sql`INSERT INTO settings(key,value) VALUES ('models.alertTest', ${sql.json({ model: CAPABILITIES.score.default })})`;
    invalidateModelCache();
    assert.ok(!(await providerStops(otherService)).includes("模块测试步骤"));
    assert.ok((await providerStops(defaultService)).includes("模块测试步骤"));

    for (const step of Object.values(capabilities())) process.env[step.env] = other;
    await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
    invalidateModelCache();
    assert.doesNotMatch(await providerStops(defaultService), /步骤停了|精选/,
      "a provider used only by historical calls must not claim current processing has stopped");
    assert.equal(await providerStops("jina"), "部分文章取不到正文");
  } finally {
    installModules(installed);
    for (const [key, value] of Object.entries(stepEnvs)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await sql`DELETE FROM settings WHERE key IN ('models.score', 'models.alertTest')`;
    invalidateModelCache();
    if (env === undefined) delete process.env.SCORE_MODEL; else process.env.SCORE_MODEL = env;
    if (moduleEnv === undefined) delete process.env.ALERT_TEST_MODEL; else process.env.ALERT_TEST_MODEL = moduleEnv;
  }
});

test("refusal and exhausted-budget findings name the currently selected provider's steps", async () => {
  const env = process.env.SCORE_MODEL;
  const label = CAPABILITIES.score.label.split("（")[0]!;
  const defaultService = MODELS[CAPABILITIES.score.default]!.service;
  const other = Object.keys(MODELS).find((key) => MODELS[key]!.service !== defaultService)!;
  const service = MODELS[other]!.service;
  try {
    process.env.SCORE_MODEL = other;
    await sql`INSERT INTO receipts(logical_key,service,purpose,status) VALUES ('alert-provider-routing',${service},'score_article','failed')`;
    const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key='alert-provider-routing'`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sql`INSERT INTO receipt_attempts(receipt_id,service,attempt,status,error,origin)
        VALUES(${receipt!.id},${service},${attempt},'failed','HTTP 402 insufficient balance','live')`;
    }
    await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},0,0,3) ON CONFLICT(service) DO UPDATE SET per_day=3`;
    const findings = await collectFindings();
    for (const key of [`provider.refused.${service}`, `budget.day.${service}`]) {
      const impact = findings.find((f) => f.key === key)?.impact;
      assert.ok(impact?.includes(label), `${key} lists scoring on its current provider`);
      assert.doesNotMatch(impact!, /\[object Promise\]/);
    }
  } finally {
    await sql`DELETE FROM receipt_attempts WHERE receipt_id IN (SELECT id FROM receipts WHERE logical_key='alert-provider-routing')`;
    await sql`DELETE FROM receipts WHERE logical_key='alert-provider-routing'`;
    await sql`DELETE FROM budgets WHERE service=${service}`;
    if (env === undefined) delete process.env.SCORE_MODEL; else process.env.SCORE_MODEL = env;
    invalidateModelCache();
  }
});

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
