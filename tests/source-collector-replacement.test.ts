// Failure cases: a working official endpoint may require another ordinary collector; replacing it
// must not recreate the source, reset backfill, leave old validators, skip audit/publication, accept
// an incomplete config, race a stale edit, or turn a paid/module-managed kind into a free collector.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { updateSource } from "@aihot/backend/admin/sources";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { republishKey } from "@aihot/backend/jobs/publication";
import { stopBoss } from "@aihot/backend/jobs/queue";

after(async () => { await stopBoss(); await closeDb(); });
async function source(kind = "rss", config: Record<string, unknown> = { feedUrl: `https://example.com/${tag()}` }) {
  const id = `replace-${tag()}`;
  const [row] = await sql`INSERT INTO sources (id, name, kind, config) VALUES (${id}, ${id}, ${kind}, ${sql.json(config as never)}) RETURNING *`;
  return row!;
}
async function edit(id: string, patch: unknown) {
  const [row] = await sql`SELECT updated_at FROM sources WHERE id = ${id}`;
  return updateSource(id, { patch, version: (row!.updated_at as Date).toISOString(), reason: "Official collection endpoint changed" }, "test-replacement");
}
const jsonConfig = () => ({ url: `https://example.com/${tag()}.json`, titlePaths: ["name"], urlTemplate: "https://example.com/news/{id}" });

test("ordinary collector replacement retains source, history and admission boundaries and resets only collector validators", async () => {
  const boundary = "2026-10-01T00:00:00.000Z";
  const row = await source("rss", { feedUrl: `https://example.com/${tag()}`, publishedAfter: boundary });
  const cursor = { initializedAt: "2026-09-30T00:00:00.000Z", lastOkAt: "2026-10-02T00:00:00.000Z", rss: { etag: "old-validator" }, detailRules: "old-rules" };
  await sql`UPDATE sources SET cursor = ${sql.json(cursor)} WHERE id = ${row.id}`;
  const material = await upsertMaterial({ sourceId: row.id, url: `https://example.com/${tag()}`, title: "Existing article", publishedAt: new Date(boundary), via: "fetch" });
  const replacement = await edit(row.id, { kind: "web_list", config: { url: `https://example.com/${tag()}`, itemSelector: "article" } });
  assert.equal(replacement!.kind, "web_list");
  assert.equal(replacement!.id, row.id);
  assert.equal(replacement!.config.publishedAfter, boundary);
  assert.deepEqual(replacement!.cursor, { initializedAt: cursor.initializedAt, lastOkAt: cursor.lastOkAt });
  assert.equal((await sql`SELECT id FROM articles WHERE source_id = ${row.id}`)[0]!.id, material.articleId);
  assert.equal((await sql`SELECT value FROM settings WHERE key = ${republishKey(row.id)}`)[0]!.value.status, "queued");
  const [audit] = await sql`SELECT before, after FROM audit_log WHERE subject = ${`source:${row.id}`} ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.before.kind, "rss");
  assert.equal(audit!.after.kind, "web_list");
  assert.equal(audit!.after.config.publishedAfter, boundary);
  assert.deepEqual(audit!.before.cursor, cursor);
  assert.deepEqual(audit!.after.cursor, replacement!.cursor);
  const second = await edit(row.id, { kind: "json_list", config: jsonConfig() });
  assert.equal(second!.id, row.id);
  assert.equal(second!.config.publishedAfter, boundary);
  await assert.rejects(edit(row.id, { kind: "rss", config: { feedUrl: "https://example.com/older", publishedAfter: "2020-01-01T00:00:00.000Z" } }));
  await assert.rejects(updateSource(row.id, { patch: { kind: "rss", config: { feedUrl: "https://example.com/changed" } }, version: (row.updated_at as Date).toISOString() }, "stale"), { code: "conflict" });
});

test("collector replacement refuses incomplete, incompatible, duplicate or special-kind inputs atomically", async () => {
  const row = await source();
  for (const patch of [
    { kind: "json_list" }, { kind: "json_list", config: {} },
    { kind: "json_list", config: { feedUrl: "https://example.com/feed" } },
    { kind: "json_list", config: { url: "https://example.com/list" } },
    ...["x_search", "mp_account", "external"].map(kind => ({ kind, config: {} })),
  ]) await assert.rejects(edit(row.id, patch));
  for (const kind of ["x_search", "mp_account", "external"]) {
    const special = await source(kind, {});
    await assert.rejects(edit(special.id, { kind: "rss", config: { feedUrl: "https://example.com/feed" } }));
  }
  const config = jsonConfig();
  await source("json_list", config);
  await assert.rejects(edit(row.id, { kind: "json_list", config }), { code: "conflict" });
  assert.equal((await sql`SELECT kind FROM sources WHERE id = ${row.id}`)[0]!.kind, "rss");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject = ${`source:${row.id}`}`).length, 0);
});

test("publisher attribution changes queue re-derivation for role, URL ownership and discovery evidence", async () => {
  for (const change of [
    { publisherRole: "person" }, { publisherUrlPrefixes: ["https://example.org/"] }, { publisherRequiresDiscovery: true },
  ]) {
    const config = { feedUrl: `https://example.com/${tag()}`, publisherRole: "organization", publisherUrlPrefixes: ["https://example.com/"], publisherRequiresDiscovery: false };
    const row = await source("rss", config);
    await edit(row.id, { config: { ...config, ...change } });
    assert.equal((await sql`SELECT value FROM settings WHERE key = ${republishKey(row.id)}`)[0]?.value.status, "queued", JSON.stringify(change));
  }
});
