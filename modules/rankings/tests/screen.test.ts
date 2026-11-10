import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { pointModels, stub } from "../../../tests/setup.ts";
import { sql } from "@aihot/backend/db";
import { screenRankings } from "../backend/screen.ts";

let malformed = false;
const provider = await stub((_hit, req) => {
  const request = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const input = JSON.parse(request.messages.at(-1)!.content) as { board_name: string; source: string; board_updated_at: string | null; fetched_at: string; items: Array<{ rank: number; title: string }> };
  const answer = { board_name: input.board_name, source: input.source, board_updated_at: input.board_updated_at, fetched_at: input.fetched_at,
    results: input.items.map((item, i) => ({ rank: item.rank, title: malformed ? "错误标题" : item.title, level: i ? "B" : "A", reason: "需查看", caution: "待核实", related_ranks: [] })) };
  return { id: "ranking-fixture", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
pointModels(provider.url);
after(async () => { await provider.close(); await sql.end(); });

test("snapshot screening saves valid results and leaves invalid output as failed", async () => {
  const items = [{ rank: 1, title: "学校调整到校时间", url: null, heat: "", origin: "" }];
  const [first] = await sql<{ id: number }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt)
    VALUES ('screen-test','测试榜','测试来源','https://example.com',${sql.json(items)},now(),'test-v1','判断') RETURNING id`;
  assert.deepEqual(await screenRankings(), { processed: 1 });
  const [saved] = await sql`SELECT status,results,receipt_id FROM external_ranking_snapshots WHERE id=${first!.id}`;
  assert.equal(saved!.status, "complete");
  assert.equal(saved!.results[0].level, "A");
  assert.ok(saved!.receipt_id);

  malformed = true;
  const [second] = await sql<{ id: number }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt)
    VALUES ('screen-test','测试榜','测试来源','https://example.com',${sql.json(items)},now()+interval '1 second','test-v1','判断') RETURNING id`;
  assert.deepEqual(await screenRankings(), { processed: 0 });
  const [failed] = await sql`SELECT status,results FROM external_ranking_snapshots WHERE id=${second!.id}`;
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.results, null);
});
