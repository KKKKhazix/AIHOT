import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
process.env.EMBEDDING_DIMS = "2";
const { EMBEDDING_MODEL, ensureEmbeddings } = await import("@aihot/backend/providers/embeddings");

const T = tag();
after(closeDb);

async function stored(kind: "fact" | "article", id: string, text: string, vector: number[]) {
  await sql`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector)
    VALUES (${kind}, ${id}, ${EMBEDDING_MODEL}, ${sha256(text)}, ${vector})
    ON CONFLICT (kind, ref_id, model) DO UPDATE SET text_hash = EXCLUDED.text_hash, vector = EXCLUDED.vector`;
}

test("fact recall keeps stored vector precision and invalidates changed fact or story text", async () => {
  const id = `cache-${T}`;
  await stored("fact", id, "fact｜story", [0.123456789, 0.987654321]);
  const [row] = await sql<{ vector: number[] }[]>`SELECT vector FROM embeddings WHERE kind = 'fact' AND ref_id = ${id}`;
  const cold = await ensureEmbeddings("fact", [{ id, text: "fact｜story" }]);
  const warm = await ensureEmbeddings("fact", [{ id, text: "fact｜story" }]);
  assert.deepEqual(cold.get(id), row!.vector);
  assert.deepEqual(warm.get(id), row!.vector);
  // A new title must never reuse the old vector, even while that vector is still cached.
  await stored("fact", id, "fact｜renamed story", [0, 1]);
  const changed = await ensureEmbeddings("fact", [{ id, text: "fact｜renamed story" }]);
  assert.deepEqual(changed.get(id), [0, 1]);
  await stored("article", id, "fact｜renamed story", [1, 0]);
  assert.deepEqual((await ensureEmbeddings("article", [{ id, text: "fact｜renamed story" }])).get(id), [1, 0]);
});

test("a same-text stored-vector repair is picked up after bounded cache expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const id = `expiry-${T}`;
  await stored("fact", id, "unchanged", [1, 0]);
  assert.deepEqual((await ensureEmbeddings("fact", [{ id, text: "unchanged" }])).get(id), [1, 0]);
  await stored("fact", id, "unchanged", [0, 1]);
  t.mock.timers.tick(5 * 60_000 + 1);
  assert.deepEqual((await ensureEmbeddings("fact", [{ id, text: "unchanged" }])).get(id), [0, 1]);
});

test("fact cache evicts beyond its bounded window", async () => {
  const id = `eviction-${T}`;
  await stored("fact", id, "old", [1, 0]);
  await ensureEmbeddings("fact", [{ id, text: "old" }]);
  const items = Array.from({ length: 4096 }, (_, i) => ({ id: `window-${T}-${i}`, text: `fact ${i}` }));
  const rows = items.map((item) => ({ kind: "fact", ref_id: item.id, model: EMBEDDING_MODEL, text_hash: sha256(item.text), vector: [0, 1] }));
  await sql`INSERT INTO embeddings ${sql(rows)}`;
  assert.equal((await ensureEmbeddings("fact", items)).size, items.length);
  await stored("fact", id, "old", [0, 1]);
  assert.deepEqual((await ensureEmbeddings("fact", [{ id, text: "old" }])).get(id), [0, 1]);
});
