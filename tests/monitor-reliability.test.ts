// Failure cases fixed before changing the monitor: malformed model output becoming an empty result;
// overlapping scan/lookback losing cursor updates; truncated initial/lookback scans losing their tail;
// unfinished review advancing the verified watermark; stale estimates/receipt dates after corrections;
// relinking deleting evidence or leaving stale activity; amendments reaching uninformed groups;
// cross-midnight windows, a model estimate before the stated time, and a duration counted as resets;
// a passed window still shown as in progress, and "by 8pm" read as a window instead of a deadline;
// health changes missing the page version, and recent reads dropping old evidence or open events.
// Calendar failure cases: correcting an old event makes it look newest; a confirmed credit on the
// same date makes an unconfirmed direct reset count as the most recent confirmed reset.
// A quiet new day/month/year must not reopen the last event's day; explicit history must still work.
import { gate, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { applyRecognition } from "@aihot/backend/monitor/assemble";
import { codexResetPage, codexResetVersion, codexResetsRecent, codexResetsSnapshot, presentationStatus } from "@aihot/backend/monitor/read";
import { RecognitionSchema, type Recognition, type Proposition } from "@aihot/backend/monitor/recognize";
import { collectPosts, flushResetPushes, monitorTick, processPending } from "@aihot/backend/monitor/scan";
import { estimateFor, resolveStatedTime, scheduleFrom } from "@aihot/backend/monitor/time";
import { relinkPost, reviewReceipt, updateMonitorEvent } from "@aihot/backend/admin/monitor";
import { beijingDate } from "@aihot/contracts/time";
import { siteCodexResetPage } from "@aihot/backend/publication/monitor";

let answer: (url: string) => unknown = () => ({ tweets: [] });
let modelAnswer: unknown = {};
const provider = await stub((_hit, req) => answer(req.url));
const model = await stub(() => ({ choices: [{ message: { content: JSON.stringify(modelAnswer) }, finish_reason: "stop" }] }));
process.env.SOCIALDATA_BASE_URL = provider.url;
process.env.SOCIALDATA_API_KEY = "test-key";
process.env.DEEPSEEK_BASE_URL = model.url;
process.env.DEEPSEEK_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

beforeEach(async () => {
  answer = () => ({ tweets: [] });
  await sql`DELETE FROM deliveries`;
  await sql`DELETE FROM notify_targets`;
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts WHERE purpose LIKE 'monitor.%'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service IN ('socialdata', 'deepseek')`;
});
after(async () => { await provider.close(); await model.close(); await stopBoss(); await closeDb(); });

let sequence = 0;
async function post(text: string, at = new Date()) {
  const id = String(9000000000000000000n + BigInt(++sequence));
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url) VALUES (${id}, 'thsottiaux', ${at}, ${text}, ${`https://x.com/thsottiaux/status/${id}`})`;
  return id;
}
const rec = (p: Partial<Proposition> = {}): Recognition => ({
  relevant: true, translationZh: "原帖译文", contextZh: [], outage: null, needsReview: false, model: "test", promptVersion: "test", receiptId: 0,
  propositions: [{ kind: "direct_reset", kindExplicit: true, action: "announce", real: true, count: 1, relatesTo: null, excerpt: "We will reset tonight", excerptZh: "今晚重置",
    statedTime: null, timeInferred: false, expectedLanding: null, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null }, ...p }],
});
async function announcement(at = new Date()) {
  const id = await post("We will reset tonight", at);
  const applied = await applyRecognition(id, rec());
  return { postId: id, eventId: applied.eventIds[0]! };
}
async function version(id: string) { return (await sql`SELECT updated_at FROM monitor_events WHERE id = ${id}`)[0]!.updated_at.toISOString(); }
async function state(key: string, value: unknown) { await sql`INSERT INTO monitor_state (key, value) VALUES (${key}, ${sql.json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`; }

test("malformed recognition remains retryable and preserves every claim", async () => {
  const valid = rec();
  for (const malformed of [{}, { ...valid, propositions: null }, { ...valid, needsReview: "false" },
    { ...valid, propositions: [valid.propositions[0], { ...valid.propositions[0], action: "done" }] }]) {
    assert.equal(RecognitionSchema.safeParse(malformed).success, false, "invalid semantics must not silently default to no events");
  }
  const id = await post("We will reset tonight");
  modelAnswer = {};
  assert.deepEqual(await processPending(), { processed: 0, failed: 1 });
  assert.equal((await sql`SELECT processed_at FROM monitor_posts WHERE id = ${id}`)[0]!.processed_at, null);
  modelAnswer = valid;
  assert.deepEqual(await processPending(), { processed: 1, failed: 0 });
  assert.equal((await codexResetsSnapshot()).events.length, 1);
});

test("normal scanning and daily lookback cannot run concurrently", async () => {
  const entered = gate(); const release = gate();
  let requests = 0;
  answer = async () => { requests++; entered.open(); await release.promise; return { tweets: [] }; };
  const first = monitorTick();
  await entered.promise;
  const second = monitorTick({ lookbackHours: 48 });
  const result = await Promise.race([second, new Promise((r) => setTimeout(() => r(null), 200))]);
  const beforeRelease = requests;
  release.open();
  await Promise.all([first, second]);
  assert.equal(result, null, "daily lookback waits instead of silently missing its only daily run");
  assert.equal(beforeRelease, 1, "no second collection while the first is still running");
  assert.equal(requests, 2, "daily lookback runs after the normal scan");
});

for (const lookbackHours of [undefined, 48]) test(`a truncated ${lookbackHours ? "lookback" : "first scan"} retains all unread pages`, async () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(8000000000000000100n - BigInt(i)));
  const queries: string[] = [];
  answer = (url) => {
    const params = new URL(url, provider.url).searchParams;
    const page = Number(params.get("cursor") ?? 0);
    queries.push(params.get("query")!);
    const since = Number(params.get("query")?.match(/since_time:(\d+)/)?.[1] ?? 0) * 1000;
    const available = ids.map((id, i) => ({ id, at: Date.now() - i * 3600_000 })).filter((p) => p.at >= since);
    const post = available[page];
    return { tweets: post ? [{ id_str: post.id, tweet_created_at: new Date(post.at).toISOString(), full_text: "hello", user: { screen_name: "thsottiaux" } }] : [], next_cursor: page + 1 < available.length ? String(page + 1) : null };
  };
  await collectPosts({ lookbackHours });
  const first = (await sql`SELECT value FROM monitor_state WHERE key = 'cursor'`)[0]!.value;
  assert.ok(first.backlog?.length, "page cap must not silently finish the window");
  await collectPosts();
  if (lookbackHours) await collectPosts(); // the first live scan also establishes coverage outside the lookback
  assert.equal((await sql`SELECT count(*) AS n FROM monitor_posts`)[0]!.n, ids.length);
  assert.equal((await sql`SELECT value FROM monitor_state WHERE key = 'cursor'`)[0]!.value.backlog, undefined);
  if (lookbackHours) assert.ok(queries.slice(6).some((q) => q === queries[0]), "resume the original lookback query");
});

test("an unresolved claim never advances the complete verification watermark", async () => {
  const checked = "2026-09-20T00:00:00Z";
  await state("watermarks", { lastVerifiedAt: checked });
  const id = await post("");
  await applyRecognition(id, rec()); // excerpt is in the quoted context only
  await monitorTick();
  const snap = await codexResetsSnapshot();
  assert.equal(Date.parse(snap.checkedAt!), Date.parse(checked));
  assert.equal(snap.monitor?.status, "attention");
});

test("uncertain announcements and withdrawals wait for review without changing public events", async () => {
  const id = await post("We will reset tonight");
  const uncertain = rec(); uncertain.needsReview = true;
  assert.deepEqual((await applyRecognition(id, uncertain)).eventIds, []);
  const { eventId } = await announcement();
  const withdrawal = await post("No reset tonight");
  const unsure = rec({ action: "withdraw", excerpt: "No reset tonight", relatesTo: eventId }); unsure.needsReview = true;
  assert.deepEqual((await applyRecognition(withdrawal, unsure)).eventIds, []);
  assert.equal((await codexResetsSnapshot()).count, 1);
});

test("old or refused backlog cursors stay visibly unfinished", async () => {
  await state("cursor", { sinceId: "900", backlog: [{ next: "rejected", stopAt: "100", since: "2020-01-01T00:00:00Z" }] });
  // The head is empty; the backlog must still be read rather than aged out.
  const queries: string[] = [];
  answer = (url) => { const cursor = new URL(url, provider.url).searchParams.get("cursor"); queries.push(cursor ?? "head"); return { tweets: [], next_cursor: cursor }; };
  await collectPosts();
  assert.ok(queries.includes("rejected"));
  assert.ok((await sql`SELECT value FROM monitor_state WHERE key = 'cursor'`)[0]!.value.backlog?.length);
  assert.ok((await codexResetsSnapshot()).monitor!.heldWindowCount > 0);
});

test("manual schedule changes replace the old estimate; reopening clears confirmation evidence", async () => {
  const { eventId } = await announcement();
  const from = new Date(Date.now() + 72 * 3600_000).toISOString();
  await updateMonitorEvent(eventId, { patch: { schedule: { precision: "window", from, through: new Date(Date.parse(from) + 3600_000).toISOString() } }, reason: "correct time", version: await version(eventId) }, "test");
  let event = (await codexResetsSnapshot()).events[0]!;
  assert.ok(Date.parse(event.estimate!.from!) >= Date.parse(from), "old estimate must not hide the corrected schedule");
  await reviewReceipt(eventId, { occurredOn: "2026-09-30", reason: "receipt", version: await version(eventId) }, "test");
  await updateMonitorEvent(eventId, { patch: { status: "announced" }, reason: "retract mistaken receipt", version: await version(eventId) }, "test");
  event = (await codexResetsSnapshot()).events[0]!;
  assert.equal(event.confirmationBasis, null);
  assert.equal(event.occurredOn, null);
  assert.equal(event.confirmedAt, null);
  assert.ok(event.estimate);
});

test("an explicitly unknown receipt day clears the old day without replacing an official confirmation", async () => {
  const { eventId } = await announcement();
  await reviewReceipt(eventId, { occurredOn: "2026-09-30", reason: "receipt", version: await version(eventId) }, "test");
  await reviewReceipt(eventId, { occurredOn: null, reason: "date uncertain", version: await version(eventId) }, "test");
  assert.equal((await codexResetsSnapshot()).events[0]!.occurredOn, null);
  const confirmation = await post("Reset has landed");
  await applyRecognition(confirmation, rec({ action: "confirm", excerpt: "Reset has landed", relatesTo: eventId }));
  await reviewReceipt(eventId, { occurredOn: "2026-09-30", reason: "account date", version: await version(eventId) }, "test");
  assert.equal((await codexResetsSnapshot()).events[0]!.confirmationBasis, "source_post");
});

test("moving a post keeps public activity consistent, and moving to itself preserves the link", async () => {
  const one = await announcement(); const two = await announcement();
  await relinkPost({ postId: one.postId, fromEventId: one.eventId, toEventId: one.eventId, reason: "same event" }, "test");
  assert.equal((await sql`SELECT count(*) AS n FROM monitor_event_posts WHERE post_id = ${one.postId}`)[0]!.n, 1);
  await relinkPost({ postId: one.postId, fromEventId: one.eventId, toEventId: two.eventId, reason: "fix association" }, "test");
  const snap = await codexResetsSnapshot();
  assert.deepEqual(snap.activities.find((p) => p.id === one.postId)!.eventIds, [two.eventId]);
});

test("a duration is not a stated number of resets", async () => {
  const id = await post("We will reset in two hours");
  await applyRecognition(id, rec({ excerpt: "We will reset in two hours", count: 2 }));
  assert.equal((await codexResetsSnapshot()).count, 1);
});

test("overnight windows stay ordered and model estimates cannot start before the stated time", () => {
  const schedule = scheduleFrom({ precision: "window", date: "2026-10-01", from: "23:00", through: "01:00" });
  assert.equal(Date.parse(schedule.through) - Date.parse(schedule.from), 2 * 3600_000);
  const exact = scheduleFrom({ precision: "exact", date: "2026-10-01", from: "18:00", through: null });
  const estimate = estimateFor({ schedule: exact, announcedAt: new Date("2026-10-01T20:00:00Z"), model: { earliestPacific: "2026-10-01 14:00", latestPacific: "2026-10-01 19:00", note: "too early" } });
  assert.ok(Date.parse(estimate.from) >= Date.parse(exact.from));
});

test("a passed window outranks an earlier 'in progress'", () => {
  const window = { from: "2026-09-25T02:00:00Z", through: "2026-09-25T04:00:00Z", basis: "source", label: "", reason: "" };
  const e = { status: "announced" as const, estimate: window, schedule: null, presentation: { inProgress: true } as never };
  assert.equal(presentationStatus(e, Date.parse("2026-09-25T03:00:00Z")), "in_progress");
  assert.equal(presentationStatus(e, Date.parse("2026-09-29T03:00:00Z")), "likely_completed");
});

test("'by 8pm' stays a deadline and is expected from the announcement until shortly after", () => {
  const postAt = new Date("2026-09-25T20:00:00Z"); // 13:00 Pacific
  const stated = resolveStatedTime({ precision: "deadline", relativeHours: null, period: null, clock: "20:00", clockThrough: null, dayOffset: null }, postAt)!;
  assert.equal(stated.precision, "deadline");
  const schedule = scheduleFrom(stated);
  assert.match(schedule.label, /前$/);
  const estimate = estimateFor({ schedule, announcedAt: postAt });
  assert.equal(estimate.from, postAt.toISOString(), "from the announcement");
  assert.equal(Date.parse(estimate.through) - Date.parse(schedule.through), 3600_000, "an hour after the deadline");
});

test("only a group that received the announcement receives its amendment, with the source text", async () => {
  const { postId, eventId } = await announcement();
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled) VALUES ('main', 'content', 'log', true), ('mirror', 'content', 'log', true)`;
  const dedupeKey = `codex:${postId}:${eventId}:announce`;
  await sql`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status) VALUES ('main', 'codex_reset', ${eventId}, ${dedupeKey}, 'sent'), ('mirror', 'codex_reset', ${eventId}, ${dedupeKey}, 'skipped')`;
  const id = await post("No reset tonight");
  await applyRecognition(id, rec({ action: "withdraw", excerpt: "No reset tonight", relatesTo: eventId }));
  await flushResetPushes();
  const deliveries = await sql`SELECT target_key, payload FROM deliveries WHERE dedupe_key LIKE ${`codex:${id}:%`}`;
  assert.deepEqual(deliveries.map((d) => d.target_key), ["main"]);
  assert.match(JSON.stringify(deliveries[0]!.payload), /原帖译文/, "withdrawal still includes its post after the event leaves the public snapshot");
});

test("monitor health invalidates the page version independently of events", async () => {
  const now = Date.now();
  await state("watermarks", { lastVerifiedAt: new Date(now).toISOString() });
  const healthy = await codexResetVersion(now);
  await post("not processed yet");
  const delayed = await codexResetVersion(now);
  assert.notEqual(delayed.version, healthy.version);
  assert.equal(delayed.version, (await codexResetPage(now)).version);
});

test("recent snapshot keeps old citations for recent events and unfinished events, with unchanged shape", async () => {
  const now = Date.now();
  const old = await announcement(new Date(now - 30 * 86400_000));
  await reviewReceipt(old.eventId, { occurredOn: null, reason: "late receipt", version: await version(old.eventId) }, "test");
  const open = await announcement(new Date(now - 20 * 86400_000));
  await sql`UPDATE monitor_events SET estimate = NULL, schedule = NULL WHERE id = ${open.eventId}`;
  const recent = await codexResetsRecent(now + 1000);
  assert.equal(recent.events.length, 2);
  assert.equal(recent.activities.length, 0);
  assert.ok(recent.events.every((e) => e.posts.length === 1));
  const full = await codexResetsSnapshot(now + 1000);
  assert.deepEqual(recent.events, full.events);
});

test("correcting an older reset does not make it the most recent completed reset", async () => {
  const now = Date.now();
  const older = await announcement(new Date(now - 7 * 86400_000));
  const newer = await announcement(new Date(now - 86400_000));
  for (const [eventId, days] of [[older.eventId, 7], [newer.eventId, 1]] as const) {
    await reviewReceipt(eventId, { occurredOn: beijingDate(now - days * 86400_000), reason: "verified day", version: await version(eventId) }, "test");
  }
  await updateMonitorEvent(older.eventId, { patch: { audienceZh: "更正历史适用范围" }, reason: "historical correction", version: await version(older.eventId) }, "test");
  assert.equal((await codexResetPage(now)).lastLanded?.id, newer.eventId);
});

test("the monitor calendar follows Beijing today across month and year boundaries without losing history", async () => {
  for (const date of ["2026-09-30", "2026-12-31"]) {
    const at = Date.parse(`${date}T23:59:59+08:00`);
    const last = await announcement(new Date(at - 3600_000));
    await reviewReceipt(last.eventId, { occurredOn: date, reason: "verified day", version: await version(last.eventId) }, "test");
    const before = siteCodexResetPage(await codexResetPage(at));
    assert.equal(before.selectedDate, date);
    assert.ok(before.events.some((e) => e.id === last.eventId));
    const nextPage = await codexResetPage(at + 1000);
    const next = siteCodexResetPage(nextPage);
    assert.equal(next.selectedDate, beijingDate(at + 1000), "a day with no events still opens today");
    assert.deepEqual(next.events, []);
    assert.equal(next.lastLanded?.id, last.eventId, "the last completed event remains available above the calendar");
    const history = siteCodexResetPage(nextPage, date);
    assert.equal(history.selectedDate, date);
    assert.ok(history.events.some((e) => e.id === last.eventId), "history links keep the requested day");
    assert.deepEqual(history.calendar, next.calendar);
  }
});

test("a confirmed card does not promote a same-day estimated reset in the last reset statistic", async () => {
  const now = Date.now();
  const known = await announcement(new Date(now - 7 * 86400_000));
  await reviewReceipt(known.eventId, { occurredOn: beijingDate(now - 7 * 86400_000), reason: "verified reset", version: await version(known.eventId) }, "test");
  const estimated = await announcement(new Date(now - 3 * 86400_000));
  const day = (await codexResetPage(now)).calendar.find((m) => m.eventId === estimated.eventId)!.date;
  const card = await announcement(new Date(now - 3 * 86400_000));
  await updateMonitorEvent(card.eventId, { patch: { type: "reset_credit" }, reason: "card", version: await version(card.eventId) }, "test");
  await reviewReceipt(card.eventId, { occurredOn: day, reason: "verified card", version: await version(card.eventId) }, "test");
  assert.equal((await codexResetPage(now)).stats.lastResetDate, beijingDate(now - 7 * 86400_000));
});
