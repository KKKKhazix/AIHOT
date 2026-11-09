import assert from "node:assert/strict";
import { test } from "node:test";
import { ScoreSchema, calculateScore } from "@aihot/backend/editorial/analyze";
import { SCORE_WEIGHTS } from "@aihot/industry/selection";

test("score dimensions are validated and weighted by the model's content type", () => {
  const result = ScoreSchema.parse({ itemType: "opinion_analysis", sig: 4, nov: 6, cred: 3, reson: 8, act: 6 });
  assert.deepEqual(calculateScore(result), { ...result, weights: { sig: 1, nov: 3, cred: 1, reson: 4, act: 1 }, total: 63 });
  assert.equal(ScoreSchema.safeParse({ ...result, act: 11 }).success, false);
  assert.equal(ScoreSchema.safeParse({ ...result, itemType: "other" }).success, false);
  assert.equal(ScoreSchema.safeParse({ attentionScore: 58 }).success, false);
});

test("every content type keeps a 100-point scale after the weight adjustment", () => {
  for (const [itemType, weights] of Object.entries(SCORE_WEIGHTS)) {
    assert.equal(Object.values(weights).reduce<number>((sum, weight) => sum + weight, 0), 10, itemType);
    const result = ScoreSchema.parse({ itemType, sig: 10, nov: 10, cred: 10, reson: 10, act: 10 });
    assert.equal(calculateScore(result).total, 100, itemType);
  }
});
