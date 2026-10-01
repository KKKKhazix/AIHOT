// Reset monitor collection and presentation: a gap longer than one scan's pages is read on by later
// ticks instead of being skipped; a passed window outranks "in progress"; "by 8pm" stays a deadline
// and its estimate starts at the announcement; a withdrawn or changed announcement is told.
import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { applyRecognition } from "@aihot/backend/monitor/assemble";
import { presentationStatus } from "@aihot/backend/monitor/read";
import type { Proposition, Recognition } from "@aihot/backend/monitor/recognize";
import { collectPosts } from "@aihot/backend/monitor/scan";
import { estimateFor, resolveStatedTime, scheduleFrom } from "@aihot/backend/monitor/time";

const BASE = BigInt(Date.now()) * 1000n;
// Twelve posts newer than the last one read, one a page, newest first.
const IDS = Array.from({ length: 12 }, (_, i) => String(BASE + 112n - BigInt(i)));
const socialdata = await stub((_hit, req) => {
  const page = Number(new URL(req.url, "http://stub").searchParams.get("cursor") ?? 0);
  const id = IDS[page];
  return {
    tweets: id ? [{ id_str: id, tweet_created_at: new Date().toISOString(), full_text: `post ${id}`, user: { name: "Tibo", screen_name: "thsottiaux" } }] : [],
    next_cursor: page + 1 < IDS.length ? String(page + 1) : null,
  };
});
process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

let saved: unknown = null;
let budget: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  budget = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'socialdata'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
  saved = (await sql<{ value: unknown }[]>`SELECT value FROM monitor_state WHERE key = 'cursor'`)[0]?.value ?? null;
  await sql`INSERT INTO monitor_state (key, value) VALUES ('cursor', ${sql.json({ sinceId: String(BASE + 100n) })}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
});
after(async () => {
  const b = budget[0];
  if (b) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = 'socialdata'`;
  if (saved) await sql`UPDATE monitor_state SET value = ${sql.json(saved as never)} WHERE key = 'cursor'`;
  else await sql`DELETE FROM monitor_state WHERE key = 'cursor'`;
  await sql`DELETE FROM monitor_posts WHERE id IN ${sql(IDS)}`;
  await socialdata.close();
  await stopBoss();
  await closeDb();
});

test("a gap longer than a scan's pages is read on by the next ticks, nothing skipped", async () => {
  const first = await collectPosts();
  assert.equal(first.stored, 10, "five pages from the top, five more of the gap");
  const cursor = (await sql<{ value: { sinceId: string; backlog?: unknown[] } }[]>`SELECT value FROM monitor_state WHERE key = 'cursor'`)[0]!.value;
  assert.equal(cursor.sinceId, IDS[0]);
  assert.equal(cursor.backlog?.length, 1, "the rest of the gap is kept");
  const second = await collectPosts();
  assert.equal(second.stored, 2);
  const stored = await sql<{ id: string }[]>`SELECT id FROM monitor_posts WHERE id IN ${sql(IDS)}`;
  assert.equal(stored.length, 12);
  const after = (await sql<{ value: { backlog?: unknown[] } }[]>`SELECT value FROM monitor_state WHERE key = 'cursor'`)[0]!.value;
  assert.equal(after.backlog, undefined);
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

let n = 0;
async function post(text: string, at: Date): Promise<string> {
  n += 1;
  const id = String(BASE + 500n + BigInt(n));
  IDS.push(id);
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url) VALUES (${id}, 'thsottiaux', ${at}, ${text}, ${`https://x.com/thsottiaux/status/${id}`})`;
  return id;
}
const rec = (p: Partial<Proposition> & Pick<Proposition, "action" | "excerpt">): Recognition => ({
  relevant: true, translationZh: "译文", contextZh: [], outage: null, needsReview: false, model: "test", promptVersion: "test", receiptId: 0,
  propositions: [{ kind: "direct_reset", kindExplicit: true, real: true, count: 1, relatesTo: null, excerptZh: "译", statedTime: null, timeInferred: false, expectedLanding: null,
    scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null }, ...p }],
});

test("withdrawing an announcement is something to tell", async () => {
  const at = new Date();
  const announce = await post("We will reset Codex rate limits tonight.", at);
  const applied = await applyRecognition(announce, rec({ action: "announce", excerpt: "We will reset Codex rate limits tonight" }));
  const eventId = applied.notify[0]!.eventId;
  const withdraw = await post("Change of plans, no reset tonight.", new Date(at.getTime() + 60_000));
  const second = await applyRecognition(withdraw, rec({ action: "withdraw", excerpt: "no reset tonight", relatesTo: eventId }));
  assert.deepEqual(second.notify.map((x) => [x.eventId, x.action]), [[eventId, "withdraw"]]);
});
