// Failure cases: fresh hot signals hide an editorial collection outage; intermittent failures vanish
// after one success; zero-output counts stop at the display limit; publisher attribution makes a
// working discovery source look idle; missing dates/repeated edits in signals are called bad articles.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { collectFindings } from "@aihot/backend/operations/alerts";
import { sourceHealthWeekly } from "@aihot/backend/operations/reports";

const T = tag();
const now = Date.now();
const old = new Date(now - 8 * 86400_000);
process.env.COLLECT_ENABLED = "true";
process.env.MODEL_CALLS_ENABLED = "false";
process.env.FEISHU_INTERNAL_ENABLED = "false";
before(async () => { await getBoss(); });
after(async () => { await stopBoss(); await closeDb(); });
async function source(id: string, mode = "editorial", created = old) {
  id = `${T}-${id}`;
  await sql`INSERT INTO sources(id,name,kind,participation_mode,health,created_at,last_ok_at,next_fetch_at)
    VALUES(${id},${id},'rss',${mode},'ok',${created},${new Date(now)},'2100-01-01')`;
  return id;
}
async function material(sourceId: string, suffix: string, publishedAt: Date | null = new Date(now)) {
  return upsertMaterial({ sourceId, title: suffix, url: `https://example.test/${T}/${suffix}`, via: "fetch", publishedAt, bodyStatus: "none" });
}

test("hot-signal activity does not hide editorial collection stopping", async () => {
  const editorial = await source("editorial", "editorial", new Date(now));
  const signal = await source("signal", "hot_signal", new Date(now));
  await material(signal, "signal");
  const finding = (await collectFindings(now)).find(f => f.key === "content.collect");
  assert.equal(finding?.level, "now");
  assert.match(finding!.title, /文章|编辑/);
  await material(editorial, "editorial");
  assert.equal((await collectFindings(now)).find(f => f.key === "content.collect"), undefined);
});

test("daily follow-ups retain chronic failures after a successful run, separately by use", async () => {
  const editorial = await source("chronic");
  const signal = await source("signal-intermittent", "hot_signal");
  const budget = await source("budget-limited", "editorial", new Date(now));
  await sql`INSERT INTO fetch_runs(source_id,started_at,finished_at,status,error)
    SELECT ${budget},${new Date(now)},${new Date(now)},'failed','Budget for test exhausted (day)' FROM generate_series(1,20)`;
  for (const id of [editorial, signal]) {
    await sql`INSERT INTO fetch_runs(source_id,started_at,finished_at,status,found_count,new_count,error)
      SELECT ${id}, ${new Date(now)}::timestamptz - i * interval '1 hour', ${new Date(now)}::timestamptz - i * interval '1 hour',
        CASE WHEN i BETWEEN 1 AND 5 THEN 'failed' ELSE 'ok' END, 1, 0,
        CASE WHEN i BETWEEN 1 AND 5 THEN 'HTTP 503' ELSE NULL END FROM generate_series(0,19) i`;
  }
  const findings = await collectFindings(now);
  for (const [mode, id, other] of [["editorial", editorial, signal], ["hot_signal", signal, editorial]]) {
    const f = findings.find(f => f.key === `sources.unstable.${mode}`);
    assert.equal(f?.level, "later");
    assert.ok(f!.detail!.includes(id!));
    assert.ok(!f!.detail!.includes(other!));
    assert.ok(!f!.detail!.includes(budget), "a spent budget is not a failing source");
    assert.match(f!.detail!, /5\/20/);
  }
});

test("weekly totals count every silent source and include successful attributed discoveries", async () => {
  for (let i = 0; i < 18; i++) await source(`silent-${i}`);
  const publisher = await source("publisher", "editorial", new Date(now));
  const collector = await source("collector");
  const { articleId } = await material(publisher, "shared");
  await sql`INSERT INTO article_discoveries(article_id,source_id,via,discovered_at) VALUES(${articleId},${collector},'fetch',${new Date(now)})`;
  const lines: string[] = [];
  const log = console.log;
  console.log = (value: unknown) => { lines.push(String(value)); };
  try {
    const result = await sourceHealthWeekly(now);
    assert.equal(result.silent, 20, "18 silent plus two chronic sources, not the display limit or the collector");
  } finally { console.log = log; }
  const text = lines.join("\n");
  assert.match(text, /编辑内容/);
  assert.match(text, /热度信号/);
  assert.doesNotMatch(text, new RegExp(`· ${collector}`));
});

test("quality follow-ups count undated editorial articles and edits without judging signal bodies", async () => {
  const editorial = await source("quality", "editorial", new Date(now));
  const signal = await source("quality-signal", "hot_signal", new Date(now));
  const article = await material(editorial, "undated-editorial", null);
  await material(signal, "undated-signal", null);
  await sql`INSERT INTO article_revisions(article_id,revision,title,created_at)
    SELECT ${article.articleId},i,'changed',${new Date(now)} FROM generate_series(2,6) i`;
  const findings = await collectFindings(now);
  const quality = findings.find(f => f.key === "sources.quality.editorial");
  assert.equal(quality?.level, "later");
  assert.ok(quality!.detail!.includes(editorial));
  assert.match(quality!.detail!, /缺发布时间 1/);
  assert.match(quality!.detail!, /反复修订 1/);
  assert.equal(findings.find(f => f.key === "sources.quality.hot_signal"), undefined);
});

test("saved detail budget waits and shutdowns do not alert, while HTTP errors and timeouts do", async () => {
  const budget = await source("detail-budget", "editorial", new Date(now));
  const shutdown = await source("detail-shutdown", "editorial", new Date(now));
  const mixed = await source("detail-mixed", "editorial", new Date(now));
  const legacy = await source("detail-counter", "editorial", new Date(now));
  const error = "Budget for jina exhausted (minute)";
  for (const [id, detail] of [
    [budget, { detailFailures: 2, detailErrors: [{ error }, { error: "Budget for jina exhausted (day)" }] }],
    [shutdown, { detailFailures: 15, detailErrors: Array.from({ length: 15 }, () => ({ error: "This operation was aborted" })) }],
    [mixed, { detailFailures: 4, detailErrors: [{ error }, { error: "This operation was aborted" },
      { error: "HTTP 500 for detail" }, { error: "The operation was aborted due to timeout" }] }],
    [legacy, { detailFailures: 1 }],
  ] as const) {
    await sql`INSERT INTO fetch_runs(source_id,started_at,finished_at,status,detail)
      VALUES(${id},${new Date(now)},${new Date(now)},'ok',${sql.json(detail)})`;
  }
  const finding = (await collectFindings(now)).find(f => f.key === "sources.details.editorial");
  assert.ok(finding);
  assert.ok(!finding.detail!.includes(budget));
  assert.ok(!finding.detail!.includes(shutdown));
  assert.ok(finding.detail!.includes(`${mixed}）：近 7 天 2 次`));
  assert.ok(finding.detail!.includes(`${legacy}）：近 7 天 1 次`));
});
