// Failure cases: fresh hot signals hide an editorial collection outage; intermittent failures vanish
// after one success; zero-output counts stop at the display limit; publisher attribution makes a
// working discovery source look idle; missing dates/repeated edits in signals are called bad articles.
// And the quiet judgment reads each source's own rhythm: a monthly blog is not late after a week, a
// daily one is, and a source with too little history stays visible rather than being called healthy.
// The daily follow-ups list one source and one problem per line, so each closes on its own; a quiet
// source is nothing anyone can fix (slow, or too new to judge) and is left to the weekly report.
// Detail pages fail the way runs do: a timeout in a few hundred reads is nobody's to fix, a page that
// keeps failing is, so the follow-up waits for repeated failures that are a real share of the reads.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { fillScheduledPublications, upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { collectFindings, dismissedFollowUps, dismissFollowUp, restoreFollowUp, sendDigest } from "@aihot/backend/operations/alerts";
import { sourceHealthWeekly } from "@aihot/backend/operations/reports";
import { sourceHealth, rhythmText, RHYTHM_WINDOW_DAYS } from "@aihot/backend/sources/health";

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
/** Items this source's own output is dated to, on the given days before now (old enough not to count as
 * fresh discoveries): the only thing its rhythm is read from. */
async function datedItems(sourceId: string, daysAgo: number[]) {
  for (const [i, days] of daysAgo.entries()) {
    const at = new Date(now - days * 86400_000);
    const url = `https://example.test/${sourceId}/${i}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at)
      VALUES(${`${sourceId}-d${i}`},${sourceId},${`url:${url}`},${url},${`${sourceId} ${i}`},${at},${new Date(now - 30 * 86400_000)},${at})`;
  }
}
async function failedRuns(sourceId: string, times: number, error = "HTTP 503") {
  await sql`INSERT INTO fetch_runs(source_id,started_at,finished_at,status,found_count,new_count,error)
    SELECT ${sourceId}, ${new Date(now)}::timestamptz - i * interval '1 hour', ${new Date(now)}::timestamptz - i * interval '1 hour',
      'failed', 1, 0, ${error} FROM generate_series(1,${times}) i`;
}
/** One run's detail-page reads, as the collector records them. */
async function detailRun(sourceId: string, attempts: number, failures: number) {
  await sql`INSERT INTO fetch_runs(source_id,started_at,finished_at,status,found_count,new_count,detail)
    VALUES(${sourceId},${new Date(now - 3600_000)},${new Date(now - 3600_000)},'ok',1,0,
      ${sql.json({ detailAttempts: attempts, detailFailures: failures })})`;
}
/** A first import: history that arrived in one delivery, so its publication dates reach further back
 * than the day the source started producing anything we could see. */
async function firstImport(sourceId: string, publishedDaysAgo: number[], discoveredDaysAgo: number) {
  for (const [i, days] of publishedDaysAgo.entries()) {
    const at = new Date(now - days * 86400_000);
    const url = `https://example.test/${sourceId}/import-${i}`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,backfill,backfill_reason)
      VALUES(${`${sourceId}-i${i}`},${sourceId},${`url:${url}`},${url},${`${sourceId} import ${i}`},${at},
        ${new Date(now - discoveredDaysAgo * 86400_000)},${at},true,'first-import')`;
  }
}
const quietGroup = async (mode = "editorial") => (await sourceHealth(now)).find(g => g.mode === mode)!;
/** The daily follow-ups that name this source. */
const followUps = async (sourceId: string) => (await collectFindings(now)).filter(f => f.level === "later" && f.key.endsWith(`.${sourceId}`));
/** The weekly report's lines, as sent. */
async function weekly() {
  const lines: string[] = [];
  const log = console.log;
  console.log = (value: unknown) => { if (String(value).includes("信源周报")) lines.push(...JSON.parse(String(value)).lines); };
  try { await sourceHealthWeekly(now); } finally { console.log = log; }
  return lines.join("\n");
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
  for (const [name, id] of [["编辑内容", editorial], ["热度信号", signal]]) {
    const [f, ...more] = await followUps(id!);
    assert.equal(more.length, 0);
    assert.equal(f?.key, `sources.unstable.${id}`);
    assert.ok(f!.title.startsWith(name!));
    assert.ok(f!.title.includes(id!));
    assert.match(f!.detail!, /5\/20/);
  }
  assert.deepEqual(await followUps(budget), [], "a spent budget is not a failing source");
});

test("each failing source is a follow-up of its own, closed when that source recovers", async () => {
  const first = await source("failing-first", "editorial", new Date(now));
  const second = await source("failing-second", "editorial", new Date(now));
  for (const id of [first, second]) await sql`UPDATE sources SET health = 'failing', fail_count = 6, last_error = 'HTTP 403' WHERE id = ${id}`;
  assert.deepEqual((await followUps(first)).map(f => f.key), [`sources.failing.${first}`]);
  assert.match((await followUps(first))[0]!.detail!, /连续失败 6 次，HTTP 403/);
  await sql`UPDATE sources SET health = 'ok', fail_count = 0, last_error = NULL WHERE id = ${first}`;
  assert.deepEqual(await followUps(first), []);
  assert.deepEqual((await followUps(second)).map(f => f.key), [`sources.failing.${second}`]);
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

// Undated articles and repeated revisions are different problems: one closed as accepted (dates missing by
// rule) must not hide the other arriving later (10-19 review of the ongoing closure).
test("undated editorial articles and repeated edits are follow-ups of their own, signal bodies are not judged", async () => {
  const editorial = await source("quality", "editorial", new Date(now));
  const signal = await source("quality-signal", "hot_signal", new Date(now));
  const article = await material(editorial, "undated-editorial", null);
  await material(signal, "undated-signal", null);
  await dismissFollowUp(`sources.undated.${editorial}`, "原文页本身没有发布时间", "test", now, "ongoing");
  await sql`INSERT INTO article_revisions(article_id,revision,title,created_at)
    SELECT ${article.articleId},i,'changed',${new Date(now)} FROM generate_series(2,6) i`;
  const found = await followUps(editorial);
  assert.deepEqual(found.map(f => f.key).sort(), [`sources.revisions.${editorial}`, `sources.undated.${editorial}`]);
  assert.match(found.find(f => f.key.startsWith("sources.undated"))!.detail!, /缺发布时间 1/);
  assert.match(found.find(f => f.key.startsWith("sources.revisions"))!.detail!, /反复修订 1/);
  const closed = await dismissedFollowUps(found, now);
  assert.ok(closed[`sources.undated.${editorial}`]);
  assert.equal(closed[`sources.revisions.${editorial}`], undefined, "repeated edits are not hidden by the closure of missing dates");
  assert.deepEqual(await followUps(signal), []);
});

test("detail pages that keep failing are a follow-up, an occasional timeout among hundreds of reads is not", async () => {
  // Shapes from production, 2026-10: one timeout in 545 reads; 26 in 1,309 while a page was not online yet;
  // 6 of 34 pages refused every time.
  const once = await source("detail-once", "hot_signal", new Date(now));
  const rare = await source("detail-rare", "editorial", new Date(now));
  const refused = await source("detail-refused", "editorial", new Date(now));
  await detailRun(once, 545, 1);
  await detailRun(rare, 1309, 26);
  await detailRun(refused, 28, 0);
  await detailRun(refused, 6, 6);
  assert.deepEqual(await followUps(once), [], "one failure is not a follow-up");
  assert.deepEqual(await followUps(rare), [], "many failures that are a small share of the reads are not either");
  const [f, ...more] = await followUps(refused);
  assert.equal(more.length, 0);
  assert.equal(f?.key, `sources.details.${refused}`);
  assert.match(f!.detail!, /近 7 天失败 6\/34 页/);
  const report = await weekly();
  assert.doesNotMatch(report, new RegExp(`${once}|${rare}`), "nor a line in the weekly report");
  assert.match(report, new RegExp(`详情补全失败：[^\\n]*${refused}）：近 7 天失败 6/34 页`));
});

test("a low-frequency source quiet for a week is not late, while a daily one is", async () => {
  const monthly = await source("monthly");
  const daily = await source("daily");
  // One item a month, the newest ten days ago: quiet, but inside its own rhythm.
  await datedItems(monthly, [10, 40, 70, 89]);
  // One a day until a week ago: the same silence is seven times its own gap.
  await datedItems(daily, [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const group = await quietGroup();
  assert.ok(!group.overdue.some(s => s.id === monthly), "a monthly blog is not overdue after ten days");
  assert.ok(!group.unknown.some(s => s.id === monthly), "and it is not reported at all");
  assert.ok(group.overdue.some(s => s.id === daily), "a daily source quiet for a week is overdue");
  assert.deepEqual(await followUps(daily), [], "being late is not a daily follow-up: it may never end by itself");
  const report = await weekly();
  assert.match(report, /超出自身更新节奏（先对照原站/);
  assert.match(report, new RegExp(`${daily}）：近 7 天没有新内容，平时约 1 天一条（7 倍）`));
});

test("a source without enough history to have a rhythm stays visible instead of being called fine", async () => {
  const thin = await source("thin");
  const never = await source("never");
  await datedItems(thin, [8, 38]);
  const group = await quietGroup();
  assert.ok(group.unknown.some(s => s.id === thin), "two dated days are not a rhythm");
  assert.ok(group.unknown.some(s => s.id === never), "a source that never produced anything is visible too");
  assert.ok(!group.overdue.some(s => s.id === thin || s.id === never));
  assert.match(rhythmText(group.unknown.find(s => s.id === thin)!), /近 7 天 \d+ 次抓取、0 条新内容；窗口内可比较的历史只有 2 天/);
  assert.match(rhythmText(group.unknown.find(s => s.id === never)!), /近 7 天 \d+ 次抓取、0 条新内容；从未收到过内容/);
  assert.deepEqual([...await followUps(thin), ...await followUps(never)], []);
  const report = await weekly();
  assert.match(report, new RegExp(`${thin}）：近 7 天 \\d+ 次抓取、0 条新内容；窗口内可比较的历史只有 2 天`));
  assert.match(report, new RegExp(`${never}）：近 7 天 \\d+ 次抓取、0 条新内容；从未收到过内容`));
});

// Which days count as output: a first import is the one day it arrived, only the rhythm window counts,
// and a collector's attributed discoveries are its own output. Each case would read as a daily source
// a week or more overdue if its rule were broken.
test("one first import is one output day, not one day per publication date", async () => {
  const imported = await source("import-batch");
  await firstImport(imported, [8, 9, 10, 11], 8);
  const group = await quietGroup();
  assert.ok(!group.overdue.some(s => s.id === imported));
  assert.ok(group.unknown.some(s => s.id === imported), "too little history to judge, still listed");
});

test("output older than the rhythm window is not comparable history", async () => {
  const lapsed = await source("lapsed");
  await datedItems(lapsed, [100, 101, 102, 103]);
  const group = await quietGroup();
  assert.ok(!group.overdue.some(s => s.id === lapsed));
  assert.ok(group.unknown.some(s => s.id === lapsed));
});

// Candidate reads must cover the same whole days as the rhythm calculation, including posts listed
// the day before publication and discoveries attributed to a collector instead of the publisher.
test("the first rhythm day includes scheduled publications and attributed discoveries from early that day", async () => {
  const [{ at }] = await sql<{ at: Date }[]>`SELECT date_trunc('day', ${new Date(now)}::timestamptz) + interval '12 hours' AS at`;
  const [{ firstDay }] = await sql<{ firstDay: Date }[]>`SELECT date_trunc('day', ${at}::timestamptz) - ${RHYTHM_WINDOW_DAYS} * interval '1 day' AS "firstDay"`;
  const scheduled = await source("window-scheduled");
  const publisher = await source("window-publisher");
  const collector = await source("window-collector");
  for (const day of [0, 1, 2, 3]) {
    const publishedAt = new Date(firstDay.getTime() + day * 86400_000);
    const { articleId } = await upsertMaterial({ sourceId: scheduled, title: `scheduled ${day}`,
      url: `https://example.test/${scheduled}/${day}`, via: "fetch", publishedAt,
      discoveredAt: new Date(publishedAt.getTime() - 86400_000) });
    assert.ok((await fillScheduledPublications(scheduled)).includes(articleId), "the actual publication rule accepts a post listed a day ahead");
    const url = `https://example.test/${publisher}/${day}`;
    await upsertMaterial({ sourceId: publisher, url, title: `published ${day}`, via: "fetch", publishedAt, discoveredAt: publishedAt });
    await upsertMaterial({ sourceId: collector, url, title: `published ${day}`, via: "fetch", publishedAt, discoveredAt: publishedAt });
  }
  const group = (await sourceHealth(at.getTime())).find(g => g.mode === "editorial")!;
  const ids = [scheduled, publisher, collector];
  assert.deepEqual(ids.map(id => {
    const row = [...group.overdue, ...group.unknown].find(s => s.id === id);
    return { id, evidence: row?.evidence_days, gap: row?.median_gap_days, overdue: group.overdue.includes(row!) };
  }), ids.map(id => ({ id, evidence: 4, gap: 1, overdue: true })), "all four output days count, including the first day");
});

test("an attributed discovery is the collector's output even without articles of its own", async () => {
  const publisher = await source("history-publisher");
  const collector = await source("history-collector");
  await datedItems(publisher, [8, 9, 10, 11]);
  for (const [i, days] of [8, 9, 10, 11].entries()) {
    await sql`INSERT INTO article_discoveries(article_id,source_id,via,discovered_at)
      VALUES(${`${publisher}-d${i}`},${collector},'fetch',${new Date(now - days * 86400_000)})`;
  }
  assert.ok((await quietGroup()).overdue.some(s => s.id === collector));
});

test("collection failures stay reported on their own, also when the source is past its rhythm", async () => {
  const broken = await source("broken");
  await datedItems(broken, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  await failedRuns(broken, 6);
  await sql`UPDATE sources SET health = 'failing', fail_count = 6 WHERE id = ${broken}`;
  const group = await quietGroup();
  assert.ok(group.failing.some(s => s.id === broken), "consecutive failures keep their own follow-up");
  assert.ok(!group.unstable.some(s => s.id === broken), "listed once, as failing, not also as failing often");
  assert.ok(group.overdue.some(s => s.id === broken), "a failed source past its rhythm is not excused by its silence");
  assert.deepEqual((await followUps(broken)).map(f => f.key), [`sources.failing.${broken}`]);
  assert.match(await weekly(), new RegExp(`超出自身更新节奏[^\\n]*${broken}`));
});

// Ways closing a source follow-up as "not to be fixed" goes wrong: it still shows in the digest; it is
// accepted without a reason, or for a follow-up that bundles many records (it would also hide records that
// arrive later) or for an alert; it leaves no audit trail or cannot be undone; it outlives the problem, so a
// later recurrence is never shown again; the weekly report drops it or hides why.
test("a source follow-up closed as not to be fixed leaves the digest until it is restored or goes away", async () => {
  const blocked = await source("blocked", "editorial", new Date(now));
  const KEY = `sources.failing.${blocked}`;
  const enabled = process.env.FEISHU_INTERNAL_ENABLED;
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  const log = console.log;
  const digest = async () => {
    const lines: string[] = [];
    console.log = (value: unknown) => { if (String(value).includes("系统日报")) lines.push(...JSON.parse(String(value)).lines); };
    try { await sendDigest(now); } finally { console.log = log; }
    return lines.join("\n");
  };
  const audits = () => sql<{ action: string; reason: string }[]>`SELECT action, reason FROM audit_log WHERE subject = ${`followup:${KEY}`} ORDER BY id`;
  try {
    await sql`UPDATE sources SET health = 'failing', fail_count = 9, last_error = 'HTTP 403' WHERE id = ${blocked}`;
    assert.ok((await digest()).includes(blocked));

    await assert.rejects(dismissFollowUp(KEY, " ", "test", now), /reason/);
    await assert.rejects(dismissFollowUp(`sources.failing.${T}-missing`, "typo", "test", now), /follow-up/);
    await sql`INSERT INTO receipts(logical_key,service,purpose,status) VALUES(${`bundle-${T}`},'deepseek','event_identity','unknown')`;
    assert.ok((await collectFindings(now)).some(f => f.key === "receipts.unknown"));
    await assert.rejects(dismissFollowUp("receipts.unknown", "covers later receipts too", "test", now), /source follow-up/);

    await dismissFollowUp(KEY, "原站屏蔽机房出口，改用其他信源", "test", now);
    assert.ok(!(await digest()).includes(blocked));
    assert.ok(!(await digest()).includes(blocked), "still closed the next day while the problem lasts");
    assert.match(await weekly(), new RegExp(`${blocked}）：连续失败 9 次，HTTP 403（已判定不修：原站屏蔽机房出口，改用其他信源）`));

    assert.ok(await restoreFollowUp(KEY, "原站恢复访问", "test"));
    assert.ok((await digest()).includes(blocked));
    assert.deepEqual((await audits()).map(a => [a.action, a.reason]),
      [["followup.dismiss", "原站屏蔽机房出口，改用其他信源"], ["followup.restore", "原站恢复访问"]]);

    // Closed again; the source then recovers and later fails again: the recurrence is listed.
    await dismissFollowUp(KEY, "原站屏蔽机房出口，改用其他信源", "test", now);
    await sql`UPDATE sources SET health = 'ok', fail_count = 0, last_error = NULL WHERE id = ${blocked}`;
    await digest();
    assert.equal(await restoreFollowUp(KEY, "已经过期", "test"), null, "the closure lapsed with the problem");
    await sql`UPDATE sources SET health = 'failing', fail_count = 5, last_error = 'HTTP 403' WHERE id = ${blocked}`;
    assert.ok((await digest()).includes(blocked));
  } finally {
    console.log = log;
    await sql`UPDATE sources SET health = 'ok', fail_count = 0 WHERE id = ${blocked}`;
    if (enabled === undefined) delete process.env.FEISHU_INTERNAL_ENABLED;
    else process.env.FEISHU_INTERNAL_ENABLED = enabled;
  }
});

// On 10-17 HN detail failures continued after a closure while old failures remained in the seven-day
// window. The source and problem key stayed identical, so every new observation was hidden too.
test("a source closure covers its observed history, not new failures under the same key", async () => {
  const id=await source("new-failure-after-dismissal");
  const key=`sources.details.${id}`;
  await detailRun(id,20,10);
  await dismissFollowUp(key,"fixed; old failures are waiting to leave the window","test",now);
  assert.ok((await dismissedFollowUps())[key]);
  await sql`INSERT INTO fetch_runs(source_id,started_at,finished_at,status,detail)
    VALUES(${id},${new Date(now+60_000)},${new Date(now+61_000)},'ok',${sql.json({detailAttempts:10,detailFailures:2})})`;
  assert.ok((await collectFindings(now+120_000)).some(f=>f.key===key));
  assert.equal((await dismissedFollowUps())[key],undefined,"new detail failures reopen the same source/problem without waiting seven days");
});

// 10-19: closures judging a condition acceptable (YouTube RSS 404s a few times a day, one MIT article's
// presentation mismatch recorded on every run, by-rule undated HN posts) reopened within hours, so the
// digest listed and woke Codex for the same judged condition every day. Ways an accepted closure goes
// wrong: the next failure of that same condition reopens it; it hides the condition forever, never judged
// again; it hides a source that stops working altogether (a different problem).
test("a closure accepting an ongoing condition holds through its new failures for a week, then it is judged again", async () => {
  const id = await source("accepted-ongoing");
  const key = `sources.details.${id}`;
  await detailRun(id, 20, 10);
  await dismissFollowUp(key, "原站偶发超时，下一轮即恢复", "test", now, "ongoing");
  const failAt = async (at: number) => sql`INSERT INTO fetch_runs(source_id,started_at,finished_at,status,detail)
    VALUES(${id},${new Date(at)},${new Date(at + 1000)},'ok',${sql.json({ detailAttempts: 10, detailFailures: 2 })})`;
  const closed = async (at: number) => !!(await dismissedFollowUps(await collectFindings(at), at))[key];
  await failAt(now + 60_000);
  assert.ok(await closed(now + 120_000), "a new failure of the accepted condition does not reopen it");
  await failAt(now + 6 * 86400_000);
  assert.ok(await closed(now + 6 * 86400_000 + 60_000));
  assert.equal(await closed(now + 7 * 86400_000 + 60_000), false, "after a week the condition is listed and judged again");

  await sql`UPDATE sources SET health = 'failing', fail_count = 9, last_error = 'HTTP 403' WHERE id = ${id}`;
  try {
    const failing = (await collectFindings(now + 120_000)).map(f => f.key);
    assert.ok(failing.includes(`sources.failing.${id}`), "a source that stops working is a separate follow-up");
    assert.equal((await dismissedFollowUps(await collectFindings(now + 120_000), now + 120_000))[`sources.failing.${id}`], undefined);
  } finally { await sql`UPDATE sources SET health = 'ok', fail_count = 0, last_error = NULL WHERE id = ${id}`; }
});

// 10-21 the noon patrol paused Claude's official YouTube over a flaky feed; the owner learned of it only at the
// end of an unrelated message. The weekly report names what is still paused or was partly excluded this week.
test("the weekly report names sources paused or partly excluded this week, with who and why", async () => {
  const paused = await source("paused-by-agent");
  const fenced = await source("fenced-in-admin");
  const resumed = await source("paused-then-resumed");
  await sql`UPDATE sources SET enabled = false, health = 'paused' WHERE id = ${paused}`;
  const at = new Date(now - 2 * 86400_000);
  const update = (id: string, actor: string, reason: string, before: object, after: object) =>
    sql`INSERT INTO audit_log(actor,action,subject,reason,before,after,created_at) VALUES(${actor},'source.update',${`source:${id}`},${reason},${sql.json(before as never)},${sql.json(after as never)},${at})`;
  await update(paused, "ops-script", "订阅源反复 404，按授权暂停", { enabled: true }, { enabled: false });
  await update(fenced, "admin:ou_test", "这一篇原文 404，只排除这一篇", { config: { feedUrl: "x" } }, { config: { feedUrl: "x", denyUrlPrefixes: ["https://example.test/dead"] } });
  // A second exclusion on the same source later that week is another line, not another source.
  await update(fenced, "ops-script", "又一篇原文 404", { config: { feedUrl: "x", denyUrlPrefixes: ["https://example.test/dead"] } }, { config: { feedUrl: "x", denyUrlPrefixes: ["https://example.test/dead", "https://example.test/gone"] } });
  await update(resumed, "ops-script", "误停", { enabled: true }, { enabled: false });
  // A form saved again on a source paused before this week repeats enabled=false; it was not paused this week.
  const earlier = await source("paused-before-this-week");
  await sql`UPDATE sources SET enabled = false, health = 'paused' WHERE id = ${earlier}`;
  await update(earlier, "admin:ou_test", "改一下名字", { enabled: false, name: "旧名" }, { enabled: false, name: earlier });
  const text = await weekly();
  assert.match(text, new RegExp(`本周停用、现在仍停着的信源 1 个：\\n· ${paused}（AI，[^）]+）：订阅源反复 404，按授权暂停`));
  assert.match(text, new RegExp(`本周排除了部分入口的信源 1 个：\\n· ${fenced}（后台，[^，]+，排除 https://example\\.test/dead）：这一篇原文 404，只排除这一篇\\n· ${fenced}（AI，[^，]+，排除 https://example\\.test/gone）：又一篇原文 404`));
  assert.doesNotMatch(text, new RegExp(`· ${resumed}`), "a source enabled again is not listed as paused");
  assert.doesNotMatch(text, new RegExp(`· ${earlier}`), "a source paused before this week is not listed as paused this week");
});
