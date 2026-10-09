// A publisher can rename a JSON entry's URL while keeping its own stable ID. Collection must revise
// the first material, preserve historical duplicate rows, and never reuse another source's ID.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { upsertMaterial } from "@aihot/backend/content/materials";

const T = tag();
const published = new Date().toISOString();
let version = 1;
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify([{ id: "stable-entry", title: `Research version ${version}`, slug: `article-v${version}`, published }]));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

test("stable external IDs revise the first material after URL changes without merging sources or deleting legacy duplicates", async () => {
  const ids = ["one", "two"].map(name => `test-external-${name}-${T}`);
  for (const id of ids) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
      VALUES (${id}, ${id}, 'json_list', ${sql.json({ url: base, titlePaths: ["title"], externalIdPath: "id", urlTemplate: `https://example.org/${id}/{slug}`, publishedAtPath: "published" })},
      'T2', 'hot_signal', ${sql.json({ initializedAt: published })}, '2100-01-01')`;
  }
  assert.equal((await collectSource(ids[0]!, { force: true })).created, 1);
  const [first] = await sql<{ id: string; identity_key: string }[]>`SELECT id, identity_key FROM articles WHERE source_id = ${ids[0]!}`;
  await upsertMaterial({ sourceId: ids[0]!, url: `https://example.org/${ids[0]}/legacy-duplicate`, title: "Legacy duplicate", publishedAt: new Date(published), raw: { externalId: "stable-entry" }, via: "import" });
  version = 2;
  const run = await collectSource(ids[0]!, { force: true });
  assert.equal(run.created, 0);
  assert.equal(run.revised, 1);
  const rows = await sql<{ id: string; identity_key: string; title: string }[]>`SELECT id, identity_key, title FROM articles WHERE source_id = ${ids[0]!} ORDER BY discovered_at, id`;
  assert.equal(rows.length, 2, "the existing duplicate remains historical data");
  assert.deepEqual(rows[0], { ...first!, title: "Research version 2" });
  assert.equal((await collectSource(ids[1]!, { force: true })).created, 1, "the same upstream ID in another source is distinct");
  version = 3;
  assert.equal((await collectSource(ids[0]!, { force: true })).created, 0);
  assert.equal((await sql`SELECT id FROM articles WHERE source_id = ${ids[0]!}`).length, 2);
});
