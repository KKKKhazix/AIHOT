import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sql } from "@aihot/backend/db";
import { collectRankings } from "../backend/collect.ts";
import { loadRankings } from "../backend/publication.ts";

test("keeps the last successful ranking after a source failure", async () => {
  const original = globalThis.fetch;
  const directory = '<section id="all-bangs"><a class="catcard" href="/hot/weibo/"><h3>微博热搜</h3></a></section><p class="updated">数据更新于 2026-11-07 10:30</p><ol id="list"><li class="row"><span class="rank">1</span><a class="row-title" href="https://example.com/a">热点</a></li></ol>';
  try {
    globalThis.fetch = async () => new Response(directory, { status: 200 });
    assert.deepEqual(await collectRankings(), { boards: 2, failed: 0 });
    let board = (await loadRankings()).find(b => b.id === "tunbang:weibo")!;
    assert.equal(board.items[0].title, "热点");
    assert.equal(board.screenStatus, "pending");
    const [first] = await sql<{ id: number }[]>`SELECT id FROM external_ranking_snapshots WHERE board_id='tunbang:weibo' ORDER BY id DESC LIMIT 1`;
    await sql`UPDATE external_ranking_snapshots SET status='complete',results=${sql.json([{rank:1,title:"热点",level:"A",reason:"线索",caution:"待核",related_ranks:[]}])} WHERE id=${first!.id}`;
    board = (await loadRankings()).find(b => b.id === "tunbang:weibo")!;
    assert.equal(board.judgements?.[0]?.level, "A");
    await collectRankings();
    board = (await loadRankings()).find(b => b.id === "tunbang:weibo")!;
    assert.equal(board.screenStatus, "pending", "a new snapshot does not inherit the previous judgement");
    assert.equal(board.judgements, null);
    assert.equal((await sql`SELECT id FROM external_ranking_snapshots WHERE board_id='tunbang:weibo'`).length, 2, "older snapshot is retained");
    const fetched = board.fetchedAt;
    globalThis.fetch = async input => String(input).endsWith("/hot/") ? new Response(directory) : new Response("failed", { status: 503 });
    assert.deepEqual(await collectRankings(), { boards: 2, failed: 1 });
    board = (await loadRankings()).find(b => b.id === "tunbang:weibo")!;
    assert.equal(board.failed, true);
    assert.equal(board.items[0].title, "热点");
    assert.equal(String(board.fetchedAt), String(fetched));
    globalThis.fetch = async () => new Response("failed", { status: 503 });
    await assert.rejects(collectRankings());
    assert.equal((await loadRankings()).find(b => b.id === "tunbang:all")!.failed, true);
  } finally { globalThis.fetch = original; await sql.end(); }
});
