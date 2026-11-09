import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sql } from "@aihot/backend/db";
import { collectTopRankings } from "../backend/collect.ts";
import { loadRankings } from "../backend/publication.ts";

test("keeps the last daily ranking when the source refuses a request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async input => {
      calls++;
      assert.equal(new URL(String(input)).searchParams.get("limit"), "1");
      return Response.json({ error: false, status: 200, data: { day: "20261109", limit: 1, items: [{ title: "日榜", url: "https://example.org" }] } });
    };
    assert.deepEqual(await collectTopRankings(), { boards: 1, failed: 0 });
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response("captcha", { status: 403 });
    await assert.rejects(collectTopRankings());
    const boards = await loadRankings();
    const day = boards.find(b => b.id === "tophub:day")!;
    assert.equal(day.items[0].title, "日榜");
    assert.equal(day.failed, true);
    assert.equal(boards.filter(b => b.source === "今日热榜").length, 1);
  } finally { globalThis.fetch = original; await sql.end(); }
});
