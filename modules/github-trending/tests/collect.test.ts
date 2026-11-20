import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { collectTrending } from "../collect.ts";
import { latestSnapshot } from "../store.ts";

after(closeDb);

const html = readFileSync(path.join(import.meta.dirname, "fixtures/trending.html"), "utf8");

test("daily collect saves snapshot and pushes top rows", async () => {
  const pushed: unknown[] = [];
  await collectTrending("daily", {
    db: sql,
    fetchHtml: async () => html,
    push: async (rows) => { pushed.push(...rows); },
  });
  const snap = await latestSnapshot(sql, "daily");
  assert.equal(snap!.rows.length, 2);
  assert.equal(pushed.length, 2);
});

test("weekly collect saves but does not push", async () => {
  let called = false;
  await collectTrending("weekly", { db: sql, fetchHtml: async () => html, push: async () => { called = true; } });
  assert.ok(await latestSnapshot(sql, "weekly"));
  assert.equal(called, false);
});

test("fetch failure keeps previous snapshot and throws", async () => {
  await assert.rejects(collectTrending("monthly", {
    db: sql, fetchHtml: async () => { throw new Error("proxy down"); }, push: async () => {},
  }));
  assert.equal(await latestSnapshot(sql, "monthly"), null);
});