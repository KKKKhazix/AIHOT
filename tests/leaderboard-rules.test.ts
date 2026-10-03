// The public rules exclude anonymous test identities: a cloaked name never becomes a model's
// representative row, while its score stays stored for audit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationOf } from "@aihot/backend/leaderboard/fetch/configuration";
import { cloakedModel } from "@aihot/backend/leaderboard/fetch/identity";
import { selectRepresentatives } from "@aihot/backend/leaderboard/fetch/store";
import { boardSubset, modelAccess } from "@aihot/backend/leaderboard/access";

test("cloaked test names are recognised in their usual spellings", () => {
  for (const name of ["ox-alpha", "Ox Alpha", "openrouter/horizon-beta", "stealth/anything", "quasar-alpha:free"]) assert.ok(cloakedModel(name), name);
  for (const name of ["gpt-5-4", "claude-opus-4-6", "alpha-model", null]) assert.ok(!cloakedModel(name), String(name));
});

test("a cloaked row is kept but never selected", () => {
  const row = (sourceModelName: string, modelId: string) => ({
    sourceModelName, modelId, metricKey: "eq-creative", metricName: "EQ", rawScore: 1971.7, configuration: configurationOf([]),
  });
  const out = selectRepresentatives([row("ox-alpha", "m1"), row("gpt-5-4", "m2")] as never, new Map([["m1", "ox-alpha"], ["m2", "gpt-5-4"]]));
  assert.deepEqual(out.map((r) => [r.sourceModelName, r.selected]), [["ox-alpha", false], ["gpt-5-4", true]]);
  assert.match(out[0]!.selectionReason, /匿名测试/);
});

test("reader filters select from the full ranking, combine, and preserve ranks and scores", () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    rank: i + 1, score: 100 - i / 2,
    access: { domestic: i % 2 === 0, weightsUrl: i % 3 === 0 ? "https://huggingface.co/org/model" : null },
  }));
  assert.deepEqual(boardSubset(rows), rows.slice(0, 30));
  const domestic = boardSubset(rows, true);
  assert.equal(domestic.length, 30);
  assert.equal(domestic.at(-1)!.rank, 59, "do not filter an already truncated top 30");
  const open = boardSubset(rows, false, true);
  assert.equal(open.length, 30);
  assert.equal(open.at(-1)!.rank, 88);
  assert.deepEqual(boardSubset(rows, true, true), rows.filter((_, i) => i % 6 === 0));
  for (const row of [...domestic, ...open]) assert.equal(row, rows[row.rank - 1]);
});

test("open weights require an exact verified model, independently of developer country", () => {
  const access = (slug: string, provider_slug: string, provider = provider_slug) => modelAccess({ slug, name: slug, provider_slug, provider });
  assert.deepEqual(access("deepseek-v-4-1-flash", "deepseek"), { domestic: true, weightsUrl: "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash" });
  assert.equal(access("gpt-oss-120-b", "openai").domestic, false);
  assert.ok(access("gpt-oss-120-b", "openai").weightsUrl);
  assert.equal(access("future-model", "deepseek").weightsUrl, null);
  assert.equal(access("mimo-v-2-6-pro", "xiaomi").weightsUrl, null, "a distilled or RL checkpoint does not prove the API model is open");
  assert.equal(access("future-model", "other", "Moonshot AI").domestic, true);
  assert.deepEqual(access("unknown", "other"), { domestic: false, weightsUrl: null });
});
