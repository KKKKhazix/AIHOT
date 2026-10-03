// Reset monitor assembly: a post confirming a stated number of resets nobody announced records each
// of them; plural wording without a number stays one; applying the same post again changes nothing.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { applyRecognition } from "@aihot/backend/monitor/assemble";
import { codexResetPage, codexResetsSnapshot } from "@aihot/backend/monitor/read";
import { codexAnswer } from "@aihot/backend/publication/agent";
import { reviewReceipt, updateMonitorEvent } from "@aihot/backend/admin/monitor";
import type { Proposition, Recognition } from "@aihot/backend/monitor/recognize";

after(async () => {
  await closeDb();
});

let n = 0;
async function post(text: string): Promise<string> {
  n += 1;
  const id = `9${Date.now()}${n}`;
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url) VALUES (${id}, 'thsottiaux', now(), ${text}, ${`https://x.com/thsottiaux/status/${id}`})`;
  return id;
}

function confirmation(excerpt: string, count: number): Recognition {
  const p: Proposition = {
    kind: "direct_reset", kindExplicit: true, action: "confirm", real: true, count, relatesTo: null, excerpt, excerptZh: "我们重置了额度",
    statedTime: null, timeInferred: false, expectedLanding: null, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null },
  };
  return { relevant: true, translationZh: "译文", contextZh: [], outage: null, needsReview: false, propositions: [p], model: "test", promptVersion: "test", receiptId: 0 };
}

const events = async (postId: string) =>
  (await sql<{ id: string; status: string }[]>`SELECT id, status FROM monitor_events WHERE id LIKE ${`%-${postId}-%`} ORDER BY id`).map((r) => ({ ...r }));

test("a confirmation of two resets nobody announced records two confirmed resets, once", async () => {
  const id = await post("We reset Codex rate limits twice today. Both are live for every paid plan.");
  const rec = confirmation("We reset Codex rate limits twice today", 2);
  const applied = await applyRecognition(id, rec);
  assert.deepEqual(await events(id), [{ id: `reset-${id}-1-1`, status: "confirmed" }, { id: `reset-${id}-1-2`, status: "confirmed" }]);
  assert.equal(applied.notify.length, 1, "one push for the post");
  const again = await applyRecognition(id, rec);
  assert.deepEqual([again.eventIds, again.notify], [[], []]);
  assert.equal((await events(id)).length, 2, "applying the post again adds nothing");
});

test("plural wording without a stated number stays one reset", async () => {
  const id = await post("We reset Codex rate limits for everyone. More resets are coming.");
  await applyRecognition(id, confirmation("We reset Codex rate limits for everyone", 2));
  assert.deepEqual(await events(id), [{ id: `reset-${id}-1-1`, status: "confirmed" }]);
});

test("a held claim from a quoted post stays out of public reset activities", async () => {
  const id = await post("");
  const rec = confirmation("10am PT, on the dot.", 1);
  rec.propositions[0]!.action = "announce";
  rec.propositions[0]!.relatesTo = "unrelated-reset";
  const applied = await applyRecognition(id, rec);
  assert.deepEqual(applied, { eventIds: [], notify: [] });
  const [stored] = await sql`SELECT recognition, activity FROM monitor_posts WHERE id = ${id}`;
  assert.equal(stored!.recognition.needsReview, true, "retain the claim for an administrator");
  assert.equal(stored!.activity, null);
  const snapshot = await codexResetsSnapshot();
  assert.equal(snapshot.activities.some((a) => a.id === id), false, "do not publish the held claim as related news");
});

test("an account receipt can settle an unspecified reset as a card without an official confirmation", async () => {
  const id = await post("More resets coming next week");
  const rec = confirmation("More resets coming next week", 1);
  Object.assign(rec.propositions[0]!, { action: "announce", kindExplicit: false });
  const { eventIds: [eventId] } = await applyRecognition(id, rec);
  const [original] = await sql`SELECT updated_at FROM monitor_events WHERE id = ${eventId!}`;
  const corrected = await updateMonitorEvent(eventId!, {
    patch: { type: "reset_credit" }, reason: "Account screenshot shows an available reset card", version: original!.updated_at.toISOString(),
  }, "test-admin");
  await reviewReceipt(eventId!, {
    occurredOn: null, reason: "Receipt checked; exact arrival date is unknown", version: corrected!.updated_at.toISOString(),
  }, "test-admin");
  const event = (await codexResetsSnapshot()).events.find((e) => e.id === eventId)!;
  assert.equal(event.type, "reset_credit");
  assert.equal(event.displayLabel, "重置卡发放");
  assert.equal(event.status, "confirmed");
  assert.equal(event.confirmationBasis, "receipt_review");
  assert.equal(event.confirmedAt, null);
  assert.equal(event.occurredOn, null);
  assert.equal(event.estimate, null);
  const answer = codexAnswer(await codexResetPage());
  assert.match(answer, /人工核实到账/);
  assert.match(answer, /不代表 Tibo 已发确认帖/);
  assert.match(answer, /到账日期未确定/);
  const [originalPost] = await sql`SELECT recognition FROM monitor_posts WHERE id = ${id}`;
  assert.deepEqual(originalPost!.recognition.notify.map((n: { action: string }) => n.action), ["announce"], "manual verification does not add a confirmation push");
});
