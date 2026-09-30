import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { LEADERBOARD_PUBLIC_BOARDS } from "@aihot/contracts/taxonomy";
import { loadBoard, loadModel } from "@aihot/backend/leaderboard/read";
import { boardSubset } from "@aihot/backend/leaderboard/access";

const runId = "test-reader-filters";
const models = [
  ...Array.from({ length: 30 }, (_, i) => ({ slug: `test-closed-${i}`, provider: "Test", provider_slug: "test" })),
  { slug: "qwen-3-32-b", provider: "Alibaba", provider_slug: "alibaba" },
  { slug: "gpt-oss-120-b", provider: "OpenAI", provider_slug: "openai" },
  { slug: "test-domestic-closed", provider: "DeepSeek", provider_slug: "deepseek" },
];

after(async () => {
  await sql`DELETE FROM lb_rankings WHERE run_id = ${runId}`;
  await sql`DELETE FROM lb_runs WHERE id = ${runId}`;
  await sql`DELETE FROM lb_models WHERE id = ANY(${models.map((_, i) => `${runId}-${i}`)})`;
  await closeDb();
});

test("all board filters include lower-ranked models whose detail pages remain readable", async () => {
  await sql`INSERT INTO lb_models ${sql(models.map((m, i) => ({ ...m, id: `${runId}-${i}`, name: m.slug })))}`;
  await sql`INSERT INTO lb_runs (id, methodology_version, generated_at, summary)
    VALUES (${runId}, 'v15', now(), ${sql.json({ consensus: { input: LEADERBOARD_PUBLIC_BOARDS.map((board) => ({ board, registry: {}, signals: [] })) } })})`;
  await sql`INSERT INTO lb_rankings ${sql(LEADERBOARD_PUBLIC_BOARDS.flatMap((board) => models.map((_, i) => ({
    run_id: runId, board, model_id: `${runId}-${i}`, rank: i + 1, score: 100 - i,
  }))))}`;

  for (const key of LEADERBOARD_PUBLIC_BOARDS) {
    const board = await loadBoard(key);
    assert.ok(board);
    assert.equal(board.run.methodologyVersion, "v15");
    assert.equal(board.entries.length, 30);
    assert.deepEqual(board.filterEntries.map((e) => e.rank), [31, 32, 33]);
    const all = [...board.entries, ...board.filterEntries];
    assert.deepEqual(boardSubset(all, true).map((e) => [e.rank, e.score]), [[31, 70], [33, 68]]);
    assert.deepEqual(boardSubset(all, false, true).map((e) => e.rank), [31, 32]);
    assert.deepEqual(boardSubset(all, true, true).map((e) => e.rank), [31]);
  }
  for (const model of models.slice(30)) {
    const page = await loadModel(model.slug);
    assert.ok(page, model.slug);
    assert.ok(page.overall.rank! > 30);
  }
});
