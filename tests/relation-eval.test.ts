import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRelationGoldJsonl,
  relationMetrics,
  sampleRelationGold,
  storyTieMetrics,
  type RelationPrediction,
} from "../scripts/eval-relations-core.ts";
import { safeReportNamePart } from "../scripts/eval-tools.ts";

const report = (title: string) => ({
  title,
  source: "Example",
  firstParty: false,
  publishedAt: "2026-09-01T09:00:00+08:00",
  summary: title,
});

function row(caseId: string, relation: "SAME_OCCURRENCE" | "SAME_STORY" | "UNRELATED" | "ROUNDUP", split = "development") {
  return {
    caseId,
    a: report(`${caseId}-a`),
    b: report(`${caseId}-b`),
    samplingContext: { benchmarkSplit: split, samplingStratum: relation.toLowerCase() },
    gold: { relation },
  };
}

test("relation gold JSONL parses all four labels and rejects malformed rows", () => {
  const text = [
    "// comments and blank lines are ignored",
    "",
    JSON.stringify(row("same", "SAME_OCCURRENCE")),
    JSON.stringify(row("story", "SAME_STORY")),
    JSON.stringify(row("other", "UNRELATED")),
    JSON.stringify(row("roundup", "ROUNDUP", "holdout")),
  ].join("\n");
  const parsed = parseRelationGoldJsonl(text);
  assert.deepEqual(parsed.map((item) => item.gold.relation), ["SAME_OCCURRENCE", "SAME_STORY", "UNRELATED", "ROUNDUP"]);
  assert.equal(parsed[0]!.a.firstParty, false);

  const duplicate = [JSON.stringify(row("x", "UNRELATED")), JSON.stringify(row("x", "ROUNDUP"))].join("\n");
  assert.throws(() => parseRelationGoldJsonl(duplicate), /duplicate caseId/);
  assert.throws(
    () => parseRelationGoldJsonl(JSON.stringify({ ...row("bad", "UNRELATED"), gold: { relation: "MAYBE" } })),
    /gold\.relation/,
  );
  assert.throws(
    () => parseRelationGoldJsonl(JSON.stringify({ ...row("date", "UNRELATED"), a: { ...report("a"), publishedAt: "not-a-date" } })),
    /publishedAt/,
  );
});

test("sampling is deterministic and applies the split before the limit", () => {
  const rows = Array.from({ length: 12 }, (_, index) =>
    row(`case-${index}`, index % 2 ? "SAME_STORY" : "UNRELATED", index < 8 ? "development" : "holdout"),
  );
  const one = sampleRelationGold(rows, { split: "development", n: 5, seed: 11 }).map((item) => item.caseId);
  const two = sampleRelationGold(rows, { split: "development", n: 5, seed: 11 }).map((item) => item.caseId);
  const holdout = sampleRelationGold(rows, { split: "holdout", n: 20, seed: 11 });

  assert.deepEqual(one, two);
  assert.equal(one.length, 5);
  assert.equal(holdout.length, 4);
  assert.ok(holdout.every((item) => item.samplingContext?.benchmarkSplit === "holdout"));
});

test("custom split names are made safe before they enter report filenames", () => {
  assert.equal(safeReportNamePart("development"), "development");
  assert.equal(safeReportNamePart("../../holdout\\windows"), "holdout-windows");
  assert.equal(safeReportNamePart("  中文 split / 2026  "), "split-2026");
  assert.equal(safeReportNamePart("../.."), "all");
});

test("multiclass metrics expose the confusion matrix, per-class scores, macro-F1, and errors", () => {
  const predictions: RelationPrediction[] = [
    { caseId: "1", gold: "SAME_OCCURRENCE", relation: "SAME_OCCURRENCE", confidence: 0.9 },
    { caseId: "2", gold: "SAME_OCCURRENCE", relation: "SAME_STORY", confidence: 0.9 },
    { caseId: "3", gold: "SAME_STORY", relation: "SAME_STORY", confidence: 0.9 },
    { caseId: "4", gold: "UNRELATED", relation: "ROUNDUP", confidence: 0.8 },
    { caseId: "5", gold: "ROUNDUP", relation: "ROUNDUP", confidence: 0.8 },
  ];
  const metrics = relationMetrics(predictions, 6);

  assert.equal(metrics.sampleSize, 6);
  assert.equal(metrics.evaluated, 5);
  assert.equal(metrics.errors, 1);
  assert.equal(metrics.accuracy, 0.6);
  assert.equal(metrics.macroF1, 0.5);
  assert.equal(metrics.confusionMatrix.SAME_OCCURRENCE.SAME_STORY, 1);
  assert.deepEqual(metrics.perClass.SAME_OCCURRENCE, { precision: 1, recall: 0.5, f1: 0.667, support: 2 });
  assert.deepEqual(metrics.perClass.UNRELATED, { precision: 0, recall: 0, f1: 0, support: 1 });
});

test("story-level threshold metrics match the production tie semantics", () => {
  const predictions: RelationPrediction[] = [
    { caseId: "1", gold: "SAME_OCCURRENCE", relation: "SAME_OCCURRENCE", confidence: 0.9 },
    { caseId: "2", gold: "SAME_STORY", relation: "SAME_STORY", confidence: 0.77 },
    { caseId: "3", gold: "UNRELATED", relation: "SAME_STORY", confidence: 0.9 },
    { caseId: "4", gold: "ROUNDUP", relation: "ROUNDUP", confidence: 0.99 },
  ];

  assert.deepEqual(storyTieMetrics(predictions, 0.75), {
    threshold: 0.75, tp: 2, fp: 1, fn: 0, tn: 1, precision: 0.667, recall: 1, f1: 0.8, accuracy: 0.75,
  });
  assert.deepEqual(storyTieMetrics(predictions, 0.8), {
    threshold: 0.8, tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5, f1: 0.5, accuracy: 0.5,
  });
});
