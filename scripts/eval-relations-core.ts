import { RELATIONS, type Relation, type ReportView } from "@aihot/backend/events/relate";

export interface RelationGoldReport {
  title: string;
  source: string;
  firstParty: boolean;
  publishedAt: string | null;
  summary: string | null;
  frame?: { subject?: string | null; action?: string | null; object?: string | null; occurredAt?: string | null } | null;
}

export interface RelationGoldRow {
  caseId: string;
  a: RelationGoldReport;
  b: RelationGoldReport;
  samplingContext?: { benchmarkSplit?: string; samplingStratum?: string };
  gold: { relation: Relation };
}

export interface RelationPrediction {
  caseId: string;
  gold: Relation;
  relation: Relation;
  confidence: number;
  stratum?: string | null;
}

type RelationMatrix = Record<Relation, Record<Relation, number>>;

function record(value: unknown, line: number, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`line ${line}: ${field} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, key: string, line: number): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`line ${line}: ${key} must be a non-empty string`);
  return value;
}

function nullableString(obj: Record<string, unknown>, key: string, line: number): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`line ${line}: ${key} must be a string or null`);
  return value;
}

function relationField(value: unknown, line: number): Relation {
  if (typeof value !== "string" || !RELATIONS.includes(value as Relation)) {
    throw new Error(`line ${line}: gold.relation must be one of ${RELATIONS.join(", ")}`);
  }
  return value as Relation;
}

function parseFrame(value: unknown, line: number): RelationGoldReport["frame"] {
  if (value === undefined || value === null) return null;
  const obj = record(value, line, "frame");
  return {
    subject: nullableString(obj, "subject", line),
    action: nullableString(obj, "action", line),
    object: nullableString(obj, "object", line),
    occurredAt: nullableString(obj, "occurredAt", line),
  };
}

function parseReport(value: unknown, line: number, field: string): RelationGoldReport {
  const obj = record(value, line, field);
  const publishedAt = nullableString(obj, "publishedAt", line);
  if (publishedAt && Number.isNaN(new Date(publishedAt).getTime())) throw new Error(`line ${line}: ${field}.publishedAt is not a valid date`);
  if (obj.firstParty !== undefined && typeof obj.firstParty !== "boolean") throw new Error(`line ${line}: ${field}.firstParty must be a boolean`);
  return {
    title: stringField(obj, "title", line),
    source: stringField(obj, "source", line),
    firstParty: obj.firstParty === true,
    publishedAt,
    summary: nullableString(obj, "summary", line),
    frame: parseFrame(obj.frame, line),
  };
}

export function parseRelationGoldJsonl(text: string): RelationGoldRow[] {
  const rows: RelationGoldRow[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    if (!raw.trim() || raw.trim().startsWith("//")) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`line ${line}: invalid JSON: ${String(error)}`);
    }
    const obj = record(value, line, "row");
    const caseId = stringField(obj, "caseId", line);
    if (ids.has(caseId)) throw new Error(`line ${line}: duplicate caseId ${caseId}`);
    ids.add(caseId);
    const sampling = obj.samplingContext === undefined
      ? undefined
      : record(obj.samplingContext, line, "samplingContext");
    const gold = record(obj.gold, line, "gold");
    rows.push({
      caseId,
      a: parseReport(obj.a, line, "a"),
      b: parseReport(obj.b, line, "b"),
      ...(sampling
        ? {
            samplingContext: {
              benchmarkSplit: nullableString(sampling, "benchmarkSplit", line) ?? undefined,
              samplingStratum: nullableString(sampling, "samplingStratum", line) ?? undefined,
            },
          }
        : {}),
      gold: { relation: relationField(gold.relation, line) },
    });
  }
  return rows;
}

export function toReportView(report: RelationGoldReport): ReportView {
  return {
    title: report.title,
    source: report.source,
    firstParty: report.firstParty,
    at: report.publishedAt ? new Date(report.publishedAt) : null,
    summary: report.summary,
    frame: report.frame ?? null,
  };
}

function rng(seed: number) {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function sampleRelationGold(
  rows: RelationGoldRow[],
  opts: { split?: string; n?: number; seed?: number } = {},
): RelationGoldRow[] {
  const split = opts.split ?? "all";
  const n = opts.n ?? rows.length;
  const seed = opts.seed ?? 7;
  const pool = split === "all" ? rows : rows.filter((row) => row.samplingContext?.benchmarkSplit === split);
  const rand = rng(seed);
  return pool
    .map((row) => ({ row, key: rand() }))
    .sort((a, b) => a.key - b.key)
    .slice(0, Math.max(0, n))
    .map(({ row }) => row);
}

function emptyMatrix(): RelationMatrix {
  return Object.fromEntries(
    RELATIONS.map((gold) => [gold, Object.fromEntries(RELATIONS.map((predicted) => [predicted, 0]))]),
  ) as RelationMatrix;
}

function round(value: number): number {
  return +value.toFixed(3);
}

export function relationMetrics(predictions: RelationPrediction[], totalCases = predictions.length) {
  const confusionMatrix = emptyMatrix();
  for (const prediction of predictions) confusionMatrix[prediction.gold][prediction.relation]++;
  const perClass = Object.fromEntries(
    RELATIONS.map((relation) => {
      const tp = confusionMatrix[relation][relation];
      const fp = RELATIONS.filter((gold) => gold !== relation).reduce((sum, gold) => sum + confusionMatrix[gold][relation], 0);
      const support = RELATIONS.reduce((sum, predicted) => sum + confusionMatrix[relation][predicted], 0);
      const fn = support - tp;
      const precision = tp / Math.max(1, tp + fp);
      const recall = tp / Math.max(1, tp + fn);
      const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
      return [relation, { precision: round(precision), recall: round(recall), f1: round(f1), support }];
    }),
  ) as Record<Relation, { precision: number; recall: number; f1: number; support: number }>;
  const correct = RELATIONS.reduce((sum, relation) => sum + confusionMatrix[relation][relation], 0);
  const macroF1 = RELATIONS.reduce((sum, relation) => sum + perClass[relation].f1, 0) / RELATIONS.length;
  return {
    sampleSize: totalCases,
    evaluated: predictions.length,
    errors: Math.max(0, totalCases - predictions.length),
    accuracy: round(correct / Math.max(1, predictions.length)),
    macroF1: round(macroF1),
    confusionMatrix,
    perClass,
  };
}

const STORY_POSITIVE = new Set<Relation>(["SAME_OCCURRENCE", "SAME_STORY"]);

export function storyTieMetrics(predictions: RelationPrediction[], threshold: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const prediction of predictions) {
    const gold = STORY_POSITIVE.has(prediction.gold);
    const predicted = STORY_POSITIVE.has(prediction.relation) && prediction.confidence >= threshold;
    if (predicted && gold) tp++;
    else if (predicted) fp++;
    else if (gold) fn++;
    else tn++;
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  return {
    threshold,
    tp,
    fp,
    fn,
    tn,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    accuracy: round((tp + tn) / Math.max(1, tp + fp + fn + tn)),
  };
}
