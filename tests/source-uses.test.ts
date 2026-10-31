// A source can serve uses besides the news pipeline: a module declares each one (its admin label and the
// slowest pace it accepts), a source names the uses it serves, and the admin lists, filters and edits them.
// A use no installed module declares is refused, and a use's pace speeds its sources up without ever
// slowing the news pipeline's own pace or a paid listing's floor.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ZodError } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { defineServerModule, installModules } from "@aihot/backend/modules";
import { createSource, listSources, sourceDetail, updateSource } from "@aihot/backend/admin/sources";
import { adaptIntervals } from "@aihot/backend/sources/collect";

installModules([defineServerModule({
  name: "watcher",
  sourceUses: { watch: { label: "盯梢", minutes: 20 }, slow: { label: "慢慢看", minutes: 90 } },
})]);
const T = tag();
after(closeDb);

const feed = (id: string, uses?: string[]) => ({
  id: `uses-${id}-${T}`, name: `用途 ${id} ${T}`, kind: "rss", config: { feedUrl: `https://example.com/${id}-${T}.xml` }, ...(uses ? { uses } : {}),
});

test("a source names the uses it serves; one no installed module declares is refused", async () => {
  const served = await createSource(feed("served", ["watch", "watch"]), "test");
  assert.ok(served.created);
  assert.deepEqual(served.source.uses, ["watch"], "named once");
  const plain = await createSource(feed("plain"), "test");
  assert.ok(plain.created);
  assert.deepEqual(plain.source.uses, [], "the news pipeline alone");
  await assert.rejects(createSource(feed("unknown", ["nobody"]), "test"), (e: unknown) => e instanceof ZodError && /用途/.test(e.message));
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE id = ${`uses-unknown-${T}`}`;
  assert.equal(n, 0);
});

test("an admin edit changes a source's uses and is audited; an unknown use is refused", async () => {
  const created = await createSource(feed("edited"), "test");
  assert.ok(created.created);
  const id = created.source.id;
  const after = await updateSource(id, { patch: { uses: ["watch", "slow"] }, version: new Date(created.source.updated_at as unknown as string).toISOString(), reason: "加用途" }, "test");
  assert.deepEqual(after!.uses, ["watch", "slow"]);
  const [audit] = await sql<{ before: { uses: string[] }; after: { uses: string[] } }[]>`
    SELECT before, after FROM audit_log WHERE subject = ${`source:${id}`} AND action = 'source.update' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(audit!.before.uses, []);
  assert.deepEqual(audit!.after.uses, ["watch", "slow"]);
  await assert.rejects(updateSource(id, { patch: { uses: ["nobody"] }, version: new Date(after!.updated_at as Date).toISOString() }, "test"), ZodError);
});

test("the admin lists sources by use and names each use", async () => {
  await createSource(feed("listed", ["slow"]), "test");
  await createSource(feed("unlisted"), "test");
  const list = await listSources({ q: T, use: "slow" });
  assert.ok(list.rows.length >= 1);
  assert.ok(list.rows.every((r) => r.uses.includes("slow")), "only sources serving the use");
  assert.ok(list.rows.some((r) => r.id === `uses-listed-${T}`));
  assert.deepEqual(list.useLabels, { watch: "盯梢", slow: "慢慢看" });
  const detail = await sourceDetail(`uses-listed-${T}`);
  assert.deepEqual(detail!.source.uses, ["slow"]);
  assert.deepEqual(detail!.useLabels, { watch: "盯梢", slow: "慢慢看" });
});

test("a source given a use, or created with one, keeps the use's pace from then on, not from the next daily adaptation", async () => {
  await sql`INSERT INTO sources (id, name, kind, config, participation_mode, interval_minutes, next_fetch_at)
    VALUES (${`uses-slowsignal-${T}`}, 'slow signal', 'rss', ${sql.json({ feedUrl: `https://example.com/slow-${T}.xml` })}, 'hot_signal', 180, now() + interval '3 hours')`;
  const [before] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${`uses-slowsignal-${T}`}`;
  await updateSource(`uses-slowsignal-${T}`, { patch: { uses: ["watch"] }, version: before!.updated_at.toISOString() }, "test");
  const [given] = await sql<{ interval_minutes: number; due_in: number }[]>`
    SELECT interval_minutes, extract(epoch FROM next_fetch_at - now())::int / 60 AS due_in FROM sources WHERE id = ${`uses-slowsignal-${T}`}`;
  assert.equal(given!.interval_minutes, 20);
  assert.ok(given!.due_in <= 20, `read within the use's pace, not in ${given!.due_in} minutes`);
  const created = await createSource({ ...feed("born-watched", ["watch"]), interval_minutes: 60 }, "test");
  assert.ok(created.created);
  const [born] = await sql<{ interval_minutes: number }[]>`SELECT interval_minutes FROM sources WHERE id = ${created.source.id}`;
  assert.equal(born!.interval_minutes, 20);
  // A faster pace of its own stays, whatever its output would make of it.
  const quick = await createSource({ ...feed("born-quick", ["watch"]), interval_minutes: 15 }, "test");
  assert.ok(quick.created);
  assert.equal(quick.source.interval_minutes, 15);
  const plain = await createSource({ ...feed("quick-later"), interval_minutes: 15 }, "test");
  assert.ok(plain.created);
  const later = await updateSource(plain.source.id, { patch: { uses: ["slow"] }, version: new Date(plain.source.updated_at as unknown as string).toISOString() }, "test");
  assert.equal(later!.interval_minutes, 15);
  // A listing paid per read still waits its hour, however soon its uses ask for it.
  const paid = await createSource({
    id: `uses-paid-${T}`, name: `paid ${T}`, kind: "web_list", uses: ["watch"],
    config: { url: `https://r.jina.ai/https://example.com/paid-${T}`, itemSelector: "a", linkSelector: "a" },
  }, "test");
  assert.ok(paid.created);
  assert.equal(paid.source.interval_minutes, 60);
  // A WeChat account is read when the phone shows it updated, not by interval: a use leaves it as it is.
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes)
    VALUES (${`uses-mp-${T}`}, 'mp', 'mp_account', ${sql.json({ ghid: `gh_${T}` })}, 'T1_5', 'editorial', 120)`;
  const [mp] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${`uses-mp-${T}`}`;
  const watched = await updateSource(`uses-mp-${T}`, { patch: { uses: ["watch"] }, version: mp!.updated_at.toISOString() }, "test");
  assert.equal(watched!.interval_minutes, 120);
});

test("a use's pace speeds its sources up, never slows the news pipeline's pace and keeps a paid listing's floor", async () => {
  // Accounts read by shard: a plain query and a watermark.
  const x = (id: string, mode: string, uses: string[]) => sql`
    INSERT INTO sources (id, name, kind, config, participation_mode, uses, interval_minutes, cursor)
    VALUES (${`uses-${id}-${T}`}, ${id}, 'x_search', ${sql.json({ query: `from:${id.split("-").map((w) => w[0]).join("")}${T.slice(-8)} -filter:replies` })}, ${mode}, ${uses}, 45, ${sql.json({ lastTweetId: "1" })})`;
  await x("isolated-watch", "isolated", ["watch"]);
  await x("isolated-alone", "isolated", []);
  await x("editorial-watch", "editorial", ["watch"]);
  await x("editorial-slow", "editorial", ["slow"]);
  await sql`
    INSERT INTO sources (id, name, kind, config, participation_mode, uses, interval_minutes)
    VALUES (${`uses-jina-${T}`}, 'jina', 'web_list', ${sql.json({ url: `https://r.jina.ai/https://example.com/list-${T}` })}, 'isolated', ${["watch"]}, 45)`;
  await adaptIntervals();
  const minutes = Object.fromEntries((await sql<{ id: string; interval_minutes: number }[]>`
    SELECT id, interval_minutes FROM sources WHERE id LIKE ${`uses-%-${T}`}`).map((r) => [r.id.slice(5, -T.length - 1), r.interval_minutes]));
  assert.equal(minutes["isolated-watch"], 20, "the use asks for twenty minutes");
  assert.equal(minutes["isolated-alone"], 60, "nothing asks: the shard's own pace");
  assert.equal(minutes["editorial-watch"], 20, "faster than the news pipeline's half hour");
  assert.equal(minutes["editorial-slow"], 30, "a slower use leaves the news pipeline's pace alone");
  assert.equal(minutes["jina"], 60, "listings paid per read stay hourly");
});
