// Evaluates the production pairwise event-relation judge on a user-supplied gold set.
// Usage: node --env-file=.env scripts/eval-relations.ts --gold .data/relation-gold.jsonl
//        [--models default,deepseek-flash] [--split development] [--n 200] [--thresholds 0.75,0.8]
// The same pair prompt/schema as production is used; receipts make identical re-runs reusable.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { PAIR_SYSTEM, PairSchema, RELATE_PROMPT_VERSION, pairUser } from "@aihot/backend/events/relate";
import { ModelOutputError, chatJson } from "@aihot/backend/providers/llm";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import {
  parseRelationGoldJsonl,
  relationMetrics,
  sampleRelationGold,
  storyTieMetrics,
  toReportView,
  type RelationPrediction,
} from "./eval-relations-core.ts";
import { evalModels, pmap, positiveInt, safeReportNamePart, usageFor } from "./eval-tools.ts";

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: ".data/relation-gold.jsonl" },
    models: { type: "string" },
    n: { type: "string", default: "200" },
    split: { type: "string", default: "all" },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    thresholds: { type: "string", default: "0.75,0.8" },
  },
});

async function main() {
  const n = positiveInt(values.n!, "n");
  const concurrency = positiveInt(values.concurrency!, "concurrency");
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  const thresholds = values.thresholds!.split(",").map((value) => Number(value.trim()));
  if (!thresholds.length || thresholds.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("--thresholds must be comma-separated numbers between 0 and 1");
  }

  const rows = parseRelationGoldJsonl(readFileSync(path.resolve(REPO_ROOT, values.gold!), "utf8"));
  const sample = sampleRelationGold(rows, { split: values.split, n, seed });
  if (!sample.length) throw new Error(`no cases for split ${values.split}`);

  const models = await evalModels(values.models, "groupReview");

  const report: Record<string, unknown> = {};
  for (const model of models) {
    const started = Date.now();
    // Distinct gold cases can render identical prompts. Share their result, including failures,
    // so a cold run scores the same cases as a cached run and never retries a pair within one run.
    const requests = new Map<string, ReturnType<typeof chatJson<typeof PairSchema>>>();
    const results = await pmap(sample, concurrency, async (row) => {
      try {
        const user = pairUser(toReportView(row.a), toReportView(row.b));
        let request = requests.get(user);
        const shared = request !== undefined;
        if (!request) {
          request = (async () => {
            const res = await chatJson({
              model,
              purpose: "eval_relation_pair",
              subject: `relation-gold:${row.caseId}`,
              promptVersion: RELATE_PROMPT_VERSION,
              system: PAIR_SYSTEM,
              user,
              schema: PairSchema,
              temperature: 0,
              maxTokens: 400,
            });
            await completeReceipt(sql, res.receiptId);
            return res;
          })();
          requests.set(user, request);
        }
        const res = await request;
        return { row, out: res.data, receiptId: res.receiptId, reused: shared || res.reused, error: null as string | null };
      } catch (error) {
        const receiptId = error instanceof ModelOutputError ? error.receiptId : null;
        return { row, out: null, receiptId, reused: false, error: String(error).slice(0, 300) };
      }
    });

    const predictions: RelationPrediction[] = results.flatMap((result) =>
      result.out
        ? [{
            caseId: result.row.caseId,
            gold: result.row.gold.relation,
            relation: result.out.relation,
            confidence: result.out.confidence,
            stratum: result.row.samplingContext?.samplingStratum ?? null,
          }]
        : [],
    );
    const metrics = relationMetrics(predictions, sample.length);
    const usage = await usageFor(results.flatMap((result) => result.receiptId === null ? [] : [result.receiptId]));
    const summary = {
      model,
      n: sample.length,
      evaluated: metrics.evaluated,
      errors: metrics.errors,
      accuracy: metrics.accuracy,
      macroF1: metrics.macroF1,
      reused: results.filter((result) => result.reused).length,
      ...usage,
      wallSeconds: Math.round((Date.now() - started) / 1000),
    };
    const storyThresholds = thresholds.map((threshold) => storyTieMetrics(predictions, threshold));
    console.log(JSON.stringify(summary));
    console.log(storyThresholds.map((metric) =>
      `  story t=${metric.threshold} P=${metric.precision} R=${metric.recall} F1=${metric.f1}`,
    ).join("\n"));

    report[model] = {
      summary,
      confusionMatrix: metrics.confusionMatrix,
      perClass: metrics.perClass,
      storyThresholds,
      cases: results.map((result) => ({
        caseId: result.row.caseId,
        stratum: result.row.samplingContext?.samplingStratum ?? null,
        gold: result.row.gold.relation,
        decision: result.out?.relation ?? null,
        confidence: result.out?.confidence ?? null,
        a: result.out?.a ?? null,
        b: result.out?.b ?? null,
        difference: result.out?.difference ?? null,
        receiptId: result.receiptId,
        reused: result.reused,
        error: result.error,
      })),
    };
  }

  const outDir = path.join(REPO_ROOT, ".data/eval");
  mkdirSync(outDir, { recursive: true });
  const splitName = safeReportNamePart(values.split!);
  const file = path.join(outDir, `relations-${splitName}-${sample.length}-${Date.now()}.json`);
  const meta = {
    split: values.split,
    n: sample.length,
    seed,
    thresholds,
    promptVersion: RELATE_PROMPT_VERSION,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify({ meta, models: report }, null, 2));
  console.log(`report: ${file}`);
}

try {
  await main();
} finally {
  await closeDb();
}
