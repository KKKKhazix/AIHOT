// Reset monitor assembly completes the recognition's paid receipt in the transaction that writes its
// events, as every paid result is committed: business rows first, then the receipt.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { applyRecognition } from "@aihot/backend/monitor/assemble";
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

function confirmation(excerpt: string, count: number, receiptId = 0): Recognition {
  const p: Proposition = {
    kind: "direct_reset", kindExplicit: true, action: "confirm", real: true, count, relatesTo: null, excerpt, excerptZh: "我们重置了额度",
    statedTime: null, timeInferred: false, expectedLanding: null, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null },
  };
  return { relevant: true, translationZh: "译文", contextZh: [], outage: null, needsReview: false, propositions: [p], model: "test", promptVersion: "test", receiptId };
}

test("a recognition receipt is completed with the monitor business write", async () => {
  const id = await post("We reset Codex rate limits for everyone.");
  const logicalKey = `monitor-test-${id}`;
  const [receipt] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, response, attempts, received_at)
    VALUES (${logicalKey}, 'openai', 'test-model', 'monitor.recognize', ${`x:${id}`}, 'received',
            '{}'::jsonb, '{}'::jsonb, 1, now())
    RETURNING id`;

  await applyRecognition(id, confirmation("We reset Codex rate limits for everyone", 1, receipt!.id));

  const [saved] = await sql<{ status: string; completed_at: Date | null }[]>`
    SELECT status, completed_at FROM receipts WHERE id = ${receipt!.id}`;
  assert.equal(saved?.status, "completed");
  assert.ok(saved?.completed_at, "business commit records receipt completion");
});
