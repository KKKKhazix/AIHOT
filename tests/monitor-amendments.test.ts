// A post announcing several resets goes out as one card, recorded under its first event. A later
// correction to any of those events must still reach the groups that received the card, and only them.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { applyRecognition } from "@aihot/backend/monitor/assemble";
import type { Proposition, Recognition } from "@aihot/backend/monitor/recognize";
import { flushResetPushes } from "@aihot/backend/monitor/scan";

after(async () => { await stopBoss(); await closeDb(); });

let sequence = 0;
async function post(text: string) {
  const id = String(9000000000000000000n + BigInt(++sequence));
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url) VALUES (${id}, 'thsottiaux', now(), ${text}, ${`https://x.com/thsottiaux/status/${id}`})`;
  return id;
}
const proposition = (p: Partial<Proposition> = {}): Proposition => ({
  kind: "direct_reset", kindExplicit: true, action: "announce", real: true, count: 1, relatesTo: null, excerpt: "We will reset tonight", excerptZh: "今晚重置",
  statedTime: null, timeInferred: false, expectedLanding: null, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null }, ...p,
});
const recognition = (...propositions: Proposition[]): Recognition => ({
  relevant: true, translationZh: "原帖译文", contextZh: [], outage: null, needsReview: false, model: "test", promptVersion: "test", receiptId: 0, propositions,
});

test("a correction to the second event in a combined card reaches only groups that received it", async () => {
  const id = await post("We will reset tonight and grant reset credits");
  const { eventIds } = await applyRecognition(id, recognition(proposition(), proposition({ kind: "reset_credit", excerpt: "grant reset credits" })));
  assert.equal(eventIds.length, 2);
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled) VALUES ('main', 'content', 'log', true), ('mirror', 'content', 'log', true)`;
  await flushResetPushes();
  const original = await sql`SELECT subject_id, payload FROM deliveries WHERE target_key = 'main'`;
  assert.equal(original.length, 1, "both events share one card");
  assert.equal(original[0]!.subject_id, eventIds[0]);
  await sql`UPDATE deliveries SET status = 'sent' WHERE target_key = 'main'`;
  const correction = await post("No reset credits tonight");
  await applyRecognition(correction, recognition(proposition({ kind: "reset_credit", action: "withdraw", excerpt: "No reset credits tonight", relatesTo: eventIds[1]! })));
  await flushResetPushes();
  assert.deepEqual((await sql`SELECT target_key FROM deliveries WHERE dedupe_key LIKE ${`codex:${correction}:%`}`).map((d) => d.target_key), ["main"]);
});
