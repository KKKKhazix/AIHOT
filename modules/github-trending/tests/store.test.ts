import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { listCaptures, latestSnapshot, saveSnapshot, snapshotAt } from "../store.ts";
import type { TrendingRow } from "../parse.ts";

after(closeDb);

const row = (rank: number, repo: string): TrendingRow => ({
  rank, repo, description: null, language: null, stars: 10, starsPeriod: 1, url: `https://github.com/${repo}`,
});

test("save then latest returns rows in rank order", async () => {
  const at = new Date("2026-11-21T07:30:00+08:00");
  await saveSnapshot(sql, "daily", [row(2, "b/two"), row(1, "a/one")], at);
  const snap = await latestSnapshot(sql, "daily");
  assert.ok(snap);
  assert.deepEqual(snap.rows.map((r) => r.repo), ["a/one", "b/two"]);
  assert.equal(snap.capturedAt, at.toISOString());
});

test("latest picks newest capture; snapshotAt reads an old one", async () => {
  const old = new Date("2026-11-20T07:30:00+08:00");
  const fresh = new Date("2026-11-21T07:30:00+08:00");
  await saveSnapshot(sql, "weekly", [row(1, "old/repo")], old);
  await saveSnapshot(sql, "weekly", [row(1, "new/repo")], fresh);
  assert.equal((await latestSnapshot(sql, "weekly"))!.rows[0]!.repo, "new/repo");
  assert.equal((await snapshotAt(sql, "weekly", old.toISOString()))!.rows[0]!.repo, "old/repo");
  const captures = await listCaptures(sql, "weekly");
  assert.equal(captures.length, 2);
  assert.equal(captures[0]!.capturedAt, fresh.toISOString());
});

test("periods are isolated; empty period returns null", async () => {
  assert.equal(await latestSnapshot(sql, "monthly"), null);
});

test("a failing row leaves no partial snapshot", async () => {
  await assert.rejects(saveSnapshot(sql, "monthly", [
    row(1, "ok/one"),
    { ...row(2, "bad/two"), url: null as unknown as string },
  ]));
  assert.equal(await latestSnapshot(sql, "monthly"), null);
});
