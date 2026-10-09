// Failure modes: saved payloads retain an old category; refreshing reruns editorial decisions,
// mutates a historical snapshot, invalidates existing cursors, emits duplicate upserts under
// concurrent refreshes, revives a withdrawn item, or omits the manual-change audit.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PUBLIC_API_CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { refreshSelectedPayload, v1Payload } from "@aihot/backend/publication/publish";
import { selectedChanges, selectedSnapshot } from "@aihot/backend/publication/v1";

const T = tag();
const id = `${T}-saved`;
const at = new Date(Date.now() - 3600_000);
const oldCategory = PUBLIC_API_CATEGORY_KEYS[0];
const category = PUBLIC_API_CATEGORY_KEYS[1]!;
const actor = "test-payload-refresh";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${T}, 'Saved source', 'rss', 'T1')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${T}, ${id}, 'https://example.org/saved', 'Original material', ${at}, ${at})`;
  // Deliberately no analysis: a full republication would replace this saved editorial projection.
  await sql`INSERT INTO publications (article_id, title, summary, source_id, channel, url, discovered_at,
      timeline_at, sort_at, eligible, selected, seat, visible_after, visibility, category)
    VALUES (${id}, 'Saved title', 'Saved summary', ${T}, 'news', 'https://example.org/saved', ${at},
      ${at}, ${at}, true, true, true, ${at}, 'public', ${category})`;
  const payload = v1Payload({ articleId: id, title: 'Saved title', originalTitle: null, summary: 'Saved summary',
    sourceName: 'Saved source', url: 'https://example.org/saved', publishedAt: null, discoveredAt: at,
    category: oldCategory, score: null, selected: true, reason: null });
  await sql`INSERT INTO selected_ledger (seq, article_id, op, changed_at, visible_at, payload)
    VALUES (1, ${id}, 'upsert', ${at}, ${at}, ${sql.json(payload as never)})`;
  await sql`INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq)
    VALUES (${id}, true, ${sha256(stableJson(payload))}, 1)`;
});
after(closeDb);

test("refreshing a saved payload preserves history and sends one audited update through the old cursor", async () => {
  const before = await selectedSnapshot({ fields: 'minimal', limit: 100, page: null });
  assert.equal(before.items.find((item) => item.id === id)?.category, oldCategory);
  const [publication] = await sql`SELECT * FROM publications WHERE article_id = ${id}`;
  const results = await Promise.all([
    refreshSelectedPayload(id, actor, 'Refresh the public category'),
    refreshSelectedPayload(id, actor, 'Refresh the public category'),
  ]);
  assert.equal(results.filter((op) => op === 'upsert').length, 1);
  assert.equal(results.filter((op) => op === null).length, 1);
  assert.deepEqual((await sql`SELECT * FROM publications WHERE article_id = ${id}`)[0], publication);
  const changes = await selectedChanges({ cursor: before.cursor, limit: 100 });
  assert.equal(changes.changes.length, 1);
  assert.equal(changes.changes[0]?.op, 'upsert');
  if (changes.changes[0]?.op === 'upsert') assert.equal(changes.changes[0].item.category, category);
  const current = await selectedSnapshot({ limit: 100, page: null });
  assert.equal(current.items.find((item) => item.id === id)?.category, category);
  assert.equal((await sql`SELECT payload->>'category' AS category FROM selected_ledger WHERE seq = 1`)[0]?.category, oldCategory);
  const audits = await sql`SELECT actor, reason FROM audit_log WHERE subject = ${`content:${id}`}`;
  assert.deepEqual([...audits], [{ actor, reason: 'Refresh the public category' }]);
  assert.equal(await refreshSelectedPayload(id, actor, 'Repeat'), null);
  assert.equal(await refreshSelectedPayload(`${T}-missing`, actor, 'Absent'), null);
});

test("refreshing after a withdrawal emits a removal and never revives the selection", async () => {
  const before = await selectedSnapshot({ limit: 100, page: null });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  assert.equal(await refreshSelectedPayload(id, actor, 'Withdrawal'), 'remove');
  const changes = await selectedChanges({ cursor: before.cursor, limit: 100 });
  assert.deepEqual(changes.changes.map((item) => [item.op, 'id' in item ? item.id : item.item.id]), [['remove', id]]);
  assert.equal((await selectedSnapshot({ limit: 100, page: null })).items.some((item) => item.id === id), false);
});
