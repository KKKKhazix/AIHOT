// Ops alerts reach the site's operators: a problem is announced once, repeated no more than its level
// allows (hourly for reader impact), closed with one recovery message.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { checkAlerts, collectFindings, providerStops, sendDigest } from "@aihot/backend/operations/alerts";
import { CAPABILITIES, invalidateModelCache, modelFor, modelRoute, stepsOnService } from "@aihot/backend/editorial/models";
import { installModules, serverModules } from "@aihot/backend/modules";
import { MODELS } from "@aihot/backend/providers/llm";
import { assertAccepted, paidRequest } from "@aihot/backend/providers/receipts";
import { READER_WORDING } from "@aihot/industry/wording";
import { resolveDelivery } from "@aihot/backend/notify/deliver";
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

// 10-26 16:00–19:00 the egress proxy dropped: a quarter of the sources fetched each hour failed while the others
// kept bringing articles, so the stall alert stayed quiet and nobody heard. A handful failing is theirs to follow up.
test("many sources failing within the hour is announced while the rest still collect", async () => {
  process.env.COLLECT_ENABLED = "true";
  const now = Date.now();
  const ids = Array.from({ length: 300 }, (_, i) => `${SOURCE}-fetch-${i}`);
  const run = (some: string[], status: "ok" | "failed", minutesAgo: number) => sql`
    INSERT INTO fetch_runs (source_id, started_at, finished_at, status, error)
    SELECT id, ${new Date(now - minutesAgo * 60_000)}, ${new Date(now - minutesAgo * 60_000)}, ${status},
      ${status === "failed" ? "Client network socket disconnected before secure TLS connection was established" : null}
    FROM unnest(${some}::text[]) id`;
  const fetching = async (at = now, open?: Parameters<typeof collectFindings>[1]) =>
    (await collectFindings(at, open)).find((f) => f.key === "content.fetch");
  try {
    await sql`INSERT INTO sources (id, name, kind, next_fetch_at) SELECT id, id, 'rss', '2100-01-01' FROM unnest(${ids}::text[]) id`;
    await run(ids, "ok", 90);
    await run(ids.slice(60), "ok", 20);
    await run(ids.slice(0, 49), "failed", 20);
    assert.equal(await fetching(), undefined, "49 failing sources are each one's own follow-up");
    await run(ids.slice(49, 60), "failed", 15);
    const finding = await fetching();
    assert.equal(finding?.level, "now");
    assert.match(finding!.impact!, /300 个信源.*60 个/);
    assert.equal(finding!.since!.getTime(), now - 20 * 60_000, "dated by the first failure still standing");
    // A failing source is not fetched again for hours (its backoff), while the others keep being fetched: neither
    // time passing nor more successes elsewhere is recovery. Nor is pausing collection.
    const open = { "content.fetch": { title: finding!.title, since: finding!.since!.toISOString() } };
    const later = now + 2 * 3600_000;
    await run(ids.slice(60), "ok", -100);
    assert.equal((await fetching(later))?.key, "content.fetch", "still failing two hours on, with nothing refetched");
    process.env.COLLECT_ENABLED = "false";
    const resumed = now + 9 * 3600_000;
    assert.equal((await fetching(resumed, open))?.key, "content.fetch", "paused nine hours: nothing proven");
    process.env.COLLECT_ENABLED = "true";
    await run(ids.slice(60), "ok", -535);
    assert.equal((await fetching(resumed))?.key, "content.fetch", "resumed: the others fetched first prove nothing about these");
    await run(ids.slice(0, 60), "ok", -538);
    assert.equal(await fetching(resumed), undefined, "a source whose next fetch worked no longer counts");
  } finally {
    await sql`DELETE FROM sources WHERE id IN ${sql(ids)}`;
    process.env.COLLECT_ENABLED = "false";
  }
});

// A restart, a paused valve, or old failures leaving the initial detection window cannot
// close an open incident. A partial repair must keep the remaining work visible.
test("content incidents survive restarts, pauses, aging failures and partial recovery", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  const now = Date.now();
  const sent = (result: Awaited<ReturnType<typeof checkAlerts>>) => result.sent.filter(k => k.startsWith("content.process"));
  try {
    await sql`UPDATE articles SET processing_state='new',discovered_at=${new Date(now - 3 * 3600_000)} WHERE id IN ${sql(stuckIds)}`;
    assert.deepEqual(sent(await checkAlerts(now)), ["content.process"]);
    await sql`INSERT INTO settings(key,value) VALUES('heartbeat.worker',${sql.json({ startedAt: new Date(now + 60_000).toISOString() })})`;
    assert.deepEqual(sent(await checkAlerts(now + 2 * 60_000)), [], "a restart does not resolve the backlog");
    assert.ok((await collectFindings(now + 2 * 60_000)).some(f => f.key === "content.process"));
    process.env.MODEL_CALLS_ENABLED = "false";
    assert.deepEqual(sent(await checkAlerts(now + 3 * 60_000)), [], "pausing processing is not recovery");
    process.env.MODEL_CALLS_ENABLED = "true";
    await sql`UPDATE articles SET discovered_at=${new Date(now - 3600_000)} WHERE id IN ${sql(stuckIds)}`;
    assert.deepEqual(sent(await checkAlerts(now + 4 * 60_000)), [], "requeued failed work is not complete before the two-hour waiting threshold");
    await sql`UPDATE articles SET processing_state='failed',discovered_at=${new Date(now - 2 * 3600_000)} WHERE id IN ${sql(stuckIds)}`;
    assert.deepEqual(sent(await checkAlerts(now + 2 * 3600_000)), ["content.process"], "unresolved failures do not age out");
    await sql`UPDATE articles SET processing_state='analyzed' WHERE id IN ${sql(stuckIds.slice(1))}`;
    assert.deepEqual(sent(await checkAlerts(now + 2 * 3600_000 + 60_000)), [], "one unfinished article still blocks recovery");
    await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${stuckIds[0]!}`;
    assert.deepEqual(sent(await checkAlerts(now + 2 * 3600_000 + 2 * 60_000)), ["content.process:recovered"]);
  } finally {
    await sql`DELETE FROM settings WHERE key='heartbeat.worker'`;
    await sql`UPDATE articles SET processing_state='analyzed' WHERE id IN ${sql(stuckIds)}`;
    process.env.COLLECT_ENABLED = "false";
    process.env.MODEL_CALLS_ENABLED = "false";
  }
});

// F20: alerts about a paid service name the steps currently routed to it: the admin choice, else a valid
// environment choice, else the site default. Failed calls a step made before it moved do not list it;
// module steps count alike, and a step with nothing to do (an empty word list) is left out.
test("refusal and spent-budget alerts name the steps currently routed to the provider", async () => {
  const label = CAPABILITIES.score.label.split("（")[0]!;
  const fallback = CAPABILITIES.score.default;
  const other = Object.keys(MODELS).find((key) => MODELS[key]!.service !== MODELS[fallback]!.service)!;
  const services = [MODELS[fallback]!.service, MODELS[other]!.service];
  const installed = serverModules();
  const envs = Object.fromEntries(["SCORE_MODEL", "ALERT_TEST_MODEL"].map((key) => [key, process.env[key]]));
  const budgets = await sql`SELECT * FROM budgets WHERE service IN ${sql(services)}`;
  // Both services refused three scoring calls in the last hour and spent their daily budget.
  for (const service of services) {
    const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,status)
      VALUES (${`alert-routing-${service}`},${service},'score_article','failed') RETURNING id`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sql`INSERT INTO receipt_attempts(receipt_id,service,attempt,status,error,origin)
        VALUES(${receipt!.id},${service},${attempt},'failed','HTTP 402 insufficient balance','live')`;
    }
    await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},0,0,3) ON CONFLICT(service) DO UPDATE SET per_day=3`;
  }
  try {
    for (const [route, env, admin, current] of [
      ["the site default", undefined, undefined, services[0]],
      ["an environment choice", other, undefined, services[1]],
      ["the admin choice over the environment", other, fallback, services[0]],
      ["a valid environment choice over an unknown admin choice", other, "unknown-model", services[1]],
      ["the default over an unknown environment choice", "unknown-model", undefined, services[0]],
    ] as const) {
      if (env === undefined) delete process.env.SCORE_MODEL; else process.env.SCORE_MODEL = env;
      await sql`DELETE FROM settings WHERE key = 'models.score'`;
      if (admin) await sql`INSERT INTO settings(key,value) VALUES ('models.score', ${sql.json({ model: admin })})`;
      invalidateModelCache();
      const findings = await collectFindings();
      for (const service of services) for (const key of [`provider.refused.${service}`, `budget.day.${service}`]) {
        assert.equal(findings.find((f) => f.key === key)!.impact!.includes(label), service === current, `${route}: ${key}`);
      }
    }
    installModules([...installed, { name: "alert-test", models: { alertTest: { label: "模块测试步骤（说明）", env: "ALERT_TEST_MODEL", purposes: [] } } }]);
    process.env.ALERT_TEST_MODEL = other;
    assert.ok((await providerStops(services[1]!)).includes("模块测试步骤"));
    const wording = CAPABILITIES.wording.label.split("（")[0]!;
    assert.equal((await providerStops(MODELS[await modelFor("wording")]!.service)).includes(wording), READER_WORDING.length > 0);
  } finally {
    installModules(installed);
    for (const [key, value] of Object.entries(envs)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await sql`DELETE FROM settings WHERE key = 'models.score'`;
    await sql`DELETE FROM receipts WHERE logical_key LIKE 'alert-routing-%'`;
    await sql`DELETE FROM budgets WHERE service IN ${sql(services)}`;
    if (budgets.length) await sql`INSERT INTO budgets ${sql(budgets)}`;
    invalidateModelCache();
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

    await checkAlerts(now);
    await sql`UPDATE articles SET grouping_status='complete' WHERE id IN ('group-alert-brief','group-alert-revision')`;
    await sql`UPDATE publications SET selected_ready_at=${new Date(now)} WHERE article_id='group-alert-failed'`;
    assert.ok((await finding())?.key, "restarting identity work must not hide an open incident for another ten minutes");
    assert.ok(!(await checkAlerts(now + 60_000)).sent.includes("content.grouping:recovered"));
    await sql`UPDATE articles SET grouping_status='complete',grouped_at=now(),grouping_receipt_id=NULL WHERE id='group-alert-failed'`;
    assert.equal(await finding(), undefined, "successful identity repair clears the reader-impact finding");
    assert.ok((await checkAlerts(now + 2 * 60_000)).sent.includes("content.grouping:recovered"));
    assert.equal((await runsOverview()).grouping.needsAttention, 0);
  } finally {
    process.env.COLLECT_ENABLED = "false";
    process.env.MODEL_CALLS_ENABLED = "false";
    await sql`DELETE FROM publications WHERE source_id=${source}`;
    await sql`DELETE FROM articles WHERE source_id=${source}`;
    await sql`DELETE FROM sources WHERE id=${source}`;
    await sql`DELETE FROM receipt_attempts WHERE receipt_id IN (SELECT id FROM receipts WHERE logical_key='group-alert-receipt')`;
    await sql`DELETE FROM receipts WHERE logical_key='group-alert-receipt'`;
    await sql`UPDATE settings SET value=value-'content.grouping' WHERE key='alerts.state'`;
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

// The request and alert layers must agree: TPM quota errors are temporary, spending
// refusals need attention, and an unrelated input error mentioning "balance" is not an outage.
test("provider alerts use the same 429 spending classification as paid requests", async () => {
  const cases: [string, number, unknown, boolean][] = [
    ["zhipu", 429, { error: { code: "1113", message: "account unavailable" } }, true],
    ["dashscope", 429, { error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }, false],
    ["dashscope", 429, { code: "BudgetLimitExceeded", message: "budget reached" }, true],
    ["llm", 429, { error: { message: "x".repeat(900), code: "credit_balance_exhausted" } }, true],
    ["mimo", 400, { error: { message: "invalid balance parameter" } }, false],
  ];
  for (const [service, status, body, expected] of cases) {
    const purpose = `alert-429-${tag()}`;
    try {
      await assert.rejects(paidRequest({ service, purpose, identity: purpose }, async () => {
        assertAccepted(service, status, JSON.stringify(body));
        return { response: null };
      }));
      const finding = (await collectFindings()).find(f => f.key === `provider.refused.${service}`);
      assert.equal(!!finding, expected, `${service}: ${JSON.stringify(body)}`);
      if (finding) assert.equal(finding.owner, true, "only the owner can pay or fix the account");
    } finally {
      await sql`DELETE FROM receipts WHERE purpose=${purpose}`;
    }
  }
});

// Window expiry, resending and an explicit drop are not successful delivery.
test("failed deliveries remain open after a day and through resend until confirmed", async () => {
  const now = Date.now();
  await sql`INSERT INTO notify_targets(key,purpose,kind) VALUES('lifecycle','content','log')`;
  const [d] = await sql<{ id: number }[]>`INSERT INTO deliveries(target_key,subject_kind,subject_id,dedupe_key,status,updated_at)
    VALUES('lifecycle','test','1','1','failed',now()-interval '23 hours') RETURNING id`;
  assert.ok((await checkAlerts(now)).open.includes("deliveries.failed"));
  assert.ok((await checkAlerts(now+25*3600_000)).open.includes("deliveries.failed"), "age does not resend the card");
  await sql`UPDATE deliveries SET status='sending',attempts=1,updated_at=now() WHERE id=${d!.id}`;
  assert.ok((await checkAlerts(now+25*3600_000+60_000)).open.includes("deliveries.failed"), "starting the resend is not arrival");
  await sql`UPDATE deliveries SET status='unknown' WHERE id=${d!.id}`;
  await resolveDelivery(d!.id, {outcome:"sent",note:"confirmed in group"}, "test");
  assert.ok((await checkAlerts(now+25*3600_000+120_000)).sent.includes("deliveries.failed:recovered"));
});

test("a refused provider stays open without a newer successful call", async () => {
  const now=Date.now();
  const [r]=await sql<{id:number}[]>`INSERT INTO receipts(logical_key,service,purpose,status) VALUES('lifecycle-refusal','deepseek','summarize_article','failed') RETURNING id`;
  for(let n=1;n<=3;n++) await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,error) VALUES(${r!.id},${n},'deepseek','failed','deepseek HTTP 402 insufficient balance')`;
  assert.ok((await checkAlerts(now)).open.includes("provider.refused.deepseek"));
  await sql`UPDATE receipt_attempts SET started_at=now()-interval '2 hours' WHERE receipt_id=${r!.id}`;
  assert.ok((await checkAlerts(now+2*3600_000)).open.includes("provider.refused.deepseek"), "silence cannot establish restored access");
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status) VALUES(${r!.id},4,'deepseek','received')`;
  assert.ok((await checkAlerts(now+2*3600_000+60_000)).sent.includes("provider.refused.deepseek:recovered"));
});

test("a deliberately dropped delivery closes without claiming successful delivery", async () => {
  const now = Date.now();
  const [d] = await sql<{ id: number }[]>`INSERT INTO deliveries(target_key,subject_kind,subject_id,dedupe_key,status)
    VALUES('lifecycle','test','drop','drop','failed') RETURNING id`;
  await checkAlerts(now);
  await resolveDelivery(d!.id, { outcome: "drop", note: "owner accepted the missing old card" }, "test");
  const result = await checkAlerts(now + 60_000);
  assert.ok(result.sent.includes("deliveries.failed:closed"));
  assert.ok(!result.sent.includes("deliveries.failed:recovered"));
});

// Success on a different model proves neither the old allowance nor the old work recovered.
// Switching away changes the current impact, while the unresolved old limit remains explicit.
test("provider recovery follows the refused model and current routing", async () => {
  const now = Date.now();
  const before = process.env.PREFILTER_MODEL;
  process.env.PREFILTER_MODEL = "qwen3.7-flash";
  const [r] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,model,purpose,status)
    VALUES('refusal-model-scope','dashscope','qwen3.7-flash','prefilter_article','failed') RETURNING id`;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,error)
      VALUES(${r!.id},${attempt},'dashscope','qwen3.7-flash','failed','dashscope HTTP 429: {"code":"BudgetLimitExceeded"}')`;
    await checkAlerts(now);
    await sql`UPDATE receipt_attempts SET started_at=now()-interval '2 hours' WHERE receipt_id=${r!.id}`;
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status)
      VALUES(${r!.id},4,'dashscope','qwen3.8-flash','received')`;
    assert.ok((await checkAlerts(now+2*3600_000)).open.includes('provider.refused.dashscope:qwen3.7-flash'), 'another model cannot prove recovery');
    let finding=(await collectFindings(now+2*3600_000)).find(f=>f.key==='provider.refused.dashscope:qwen3.7-flash')!;
    assert.match(finding.impact!, /精选预筛/);
    assert.doesNotMatch(finding.impact!, /结构抽取/);
    process.env.PREFILTER_MODEL = "qwen3.8-flash";
    invalidateModelCache();
    finding=(await collectFindings(now+2*3600_000)).find(f=>f.key==='provider.refused.dashscope:qwen3.7-flash')!;
    assert.equal(finding.level,'later');
    assert.match(finding.impact!, /当前.*未使用.*旧限制.*未验证/);
    assert.ok(!(await checkAlerts(now+2*3600_000+60_000)).sent.includes('provider.refused.dashscope:qwen3.7-flash:recovered'));
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status)
      VALUES(${r!.id},5,'dashscope','qwen3.7-flash','received')`;
    assert.ok((await checkAlerts(now+2*3600_000+120_000)).sent.includes('provider.refused.dashscope:qwen3.7-flash:recovered'));
  } finally {
    if (before===undefined) delete process.env.PREFILTER_MODEL; else process.env.PREFILTER_MODEL=before;
    invalidateModelCache();
    await sql`DELETE FROM receipts WHERE id=${r!.id}`;
  }
});

// The evaluated fallback is an active route even when no primary uses that supplier.
test("provider impact includes the same evaluated fallback as modelRoute", async () => {
  const envs = Object.fromEntries(Object.values(CAPABILITIES).map(c => [c.env, process.env[c.env]]));
  MODELS["test-primary"] = { ...MODELS["deepseek-flash"]!, key: "test-primary" };
  MODELS["test-backup"] = { ...MODELS["glm-5.3-flash"]!, key: "test-backup", fallbackFor: { summarize: "test-primary" } };
  try {
    for (const c of Object.values(CAPABILITIES)) process.env[c.env] = "test-primary";
    invalidateModelCache();
    const route = await modelRoute("summarize");
    assert.equal(route.fallbackModel, "test-backup");
    const steps = await stepsOnService("zhipu", new Set(["glm-5.3-flash"]));
    assert.ok(steps.includes("标题摘要"), "the fallback can fail and stop articles even without a primary on this supplier");
    assert.ok(!steps.includes("精选评分"), "an unevaluated fallback is not invented for other steps");
  } finally {
    for (const [key, value] of Object.entries(envs)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    delete MODELS["test-primary"];
    delete MODELS["test-backup"];
    invalidateModelCache();
  }
});

test("a refusal first seen after switching models survives the first-hour window", async () => {
  const before = process.env.PREFILTER_MODEL;
  const now = Date.now();
  process.env.PREFILTER_MODEL = "qwen3.8-flash";
  invalidateModelCache();
  const key = "provider.refused.dashscope:qwen3.7-flash";
  const [r] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,model,purpose,status)
    VALUES('refusal-already-switched','dashscope','qwen3.7-flash','prefilter_article','failed') RETURNING id`;
  try {
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,error,started_at)
      VALUES(${r!.id},1,'dashscope','qwen3.7-flash','failed','dashscope HTTP 429: {"code":"BudgetLimitExceeded"}',${new Date(now-60_000)})`;
    await checkAlerts(now);
    const finding = (await collectFindings(now+2*3600_000)).find(f => f.key===key);
    assert.equal(finding?.level, "later", "a switched-away limit is still unverified after the detection window");
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,started_at)
      VALUES(${r!.id},2,'dashscope','qwen3.7-flash','received',${new Date(now+2*3600_000)})`;
    const recovered = await checkAlerts(now+2*3600_000+60_000);
    assert.ok(!recovered.open.includes(key));
    assert.ok(!recovered.sent.includes(`${key}:recovered`), "an incident never announced separately has no unsolicited recovery notice");
  } finally {
    if (before===undefined) delete process.env.PREFILTER_MODEL; else process.env.PREFILTER_MODEL=before;
    invalidateModelCache();
    await sql`DELETE FROM receipts WHERE id=${r!.id}`;
  }
});
