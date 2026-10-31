// Checks the selection against your own labelled samples (a "gold set"): each case runs the site's
// selection steps (editorial/analyze.ts) — the prefilter, then the score prompt twice with every model in
// --models, the two scores deciding against the case's tier threshold (gold cases carry no source class) — and is compared with your
// decision. A threshold sweep shows what another threshold would have done. The gold file has one case
// per line as eval-selection-core.ts describes; lines starting with // are skipped.
// Usage: node --env-file=.env scripts/eval-selection.ts [--gold .data/gold.jsonl] [--models default,deepseek-flash] [--n 200] [--split all] [--label "..."]
// Receipts make re-runs free; "either" cases are excluded from decisive metrics. Each run is also
// imported into SelectBench (admin → SelectBench) with every case, unless --no-import is given.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEPLOYMENT } from "@aihot/site";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import {
  SELECTION_PROMPT_VERSION,
  awaitsMaterial,
  buildScoreInput,
  runSelectionPrefilter,
  runSelectionScores,
  scoresSelect,
  selectionThreshold,
  shownScore,
  type AnalysisRun,
  type AnalyzeInputArticle,
} from "@aihot/backend/editorial/analyze";
import { importSelectBenchRun } from "@aihot/backend/admin/selectbench";
import { evalModels, pmap, positiveInt, safeReportNamePart, sampleCases, usageFor } from "./eval-tools.ts";
import { parseSelectionGoldJsonl, selectionMetrics, selectionThresholdMetrics, type SelectionDecision, type SelectionGoldRow } from "./eval-selection-core.ts";

// Without options: the site's gold set (site.ts DEPLOYMENT.selectionGold), else the whole of .data/gold.jsonl
// (up to 200 cases), swept over a wide range of thresholds.
const own = DEPLOYMENT.selectionGold;
const defaults = own
  ? { gold: own.file, n: String(own.sample), split: own.split, sweep: own.sweep }
  : { gold: ".data/gold.jsonl", n: "200", split: "all", sweep: [40, 90] };

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: defaults.gold },
    models: { type: "string" },
    n: { type: "string", default: defaults.n },
    split: { type: "string", default: defaults.split },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    label: { type: "string" },
    "no-import": { type: "boolean", default: false },
  },
});

const rows = parseSelectionGoldJsonl(readFileSync(path.resolve(REPO_ROOT, values.gold!), "utf8"));
const sample = sampleCases(rows, { split: values.split!, n: positiveInt(values.n!, "n"), seed: Number(values.seed) });
const concurrency = positiveInt(values.concurrency!, "concurrency");

function toInput(r: SelectionGoldRow): AnalyzeInputArticle {
  const m = r.material;
  const isX = r.sourceFacts.sourceKind === "x_search";
  const body = m.bodyOriginal || m.bodyZh || null;
  return {
    id: `gold-${r.caseId}`,
    revision: 1,
    bodyStatus: "ok",
    title: m.originalTitle || m.title,
    url: "https://example.invalid/" + r.caseId,
    author: null,
    publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
    bodyText: isX ? null : body,
    excerpt: null,
    xPost: isX ? { authorName: m.sourceName, handle: "", text: body ?? m.title } : null,
    media: [],
    source: { name: m.sourceName, kind: r.sourceFacts.sourceKind, tier: r.sourceFacts.sourceTier ?? "T2", firstParty: r.sourceFacts.firstParty ?? false },
  };
}

/**
 * A case as the site's rules leave it: `relevance` is what the prefilter (or missing material) decided,
 * `scores` the two scores held against the case's tier threshold. The eval writes no reader-facing copy;
 * an item past the prefilter is taken as written up, as the site writes one for every such item.
 */
interface Outcome {
  r: SelectionGoldRow;
  relevance: "pass" | "block" | "unknown" | null;
  scores: AnalysisRun["scores"];
  receiptIds: number[];
  error: string | null;
}

/** The site's decision for the case, at its tier threshold or at `threshold`; null when the case failed. */
const decide = (x: Outcome, threshold?: number): SelectionDecision | null =>
  x.error !== null ? null : x.relevance === "pass" && scoresSelect(x.scores, threshold) ? "select" : "reject";

const models = await evalModels(values.models, "score");

const report: Record<string, unknown> = {};
for (const model of models) {
  const started = performance.now();
  // Two gold cases can have different source metadata / thresholds while rendering the same score prompt.
  // Share only that score result (including a failure); prefilter and threshold semantics remain per case.
  const scoreRequests = new Map<string, Promise<{ scores: AnalysisRun["scores"]; receiptIds: number[]; error: string | null }>>();
  const results = await pmap(sample, concurrency, async (r): Promise<Outcome> => {
    const input = toInput(r);
    const receiptIds: number[] = [];
    const outcome = (relevance: Outcome["relevance"], scores: AnalysisRun["scores"] = null, error: string | null = null): Outcome =>
      ({ r, relevance, scores, receiptIds, error });
    // Only a title: the site waits for material, without a model call.
    if (awaitsMaterial(input)) return outcome("unknown");
    try {
      const prefilter = await runSelectionPrefilter(input, {}, (id) => receiptIds.push(id));
      if (prefilter.label === "BLOCK") return outcome("block");
      const threshold = selectionThreshold(input.source);
      if (threshold === null) return outcome("pass");

      const key = buildScoreInput(input);
      let request = scoreRequests.get(key);
      if (!request) {
        const sharedReceiptIds: number[] = [];
        request = runSelectionScores(input, { scoreModel: model }, (id) => sharedReceiptIds.push(id)).then(
          (scores) => ({ scores, receiptIds: sharedReceiptIds, error: null }),
          (error: unknown) => ({ scores: null, receiptIds: sharedReceiptIds, error: String(error).slice(0, 200) }),
        );
        scoreRequests.set(key, request);
      }
      const shared = await request;
      receiptIds.push(...shared.receiptIds);
      if (shared.error) return outcome(null, null, shared.error);
      // Model output is independent of source tier; the decision threshold is not.
      return outcome("pass", shared.scores ? { ...shared.scores, threshold } : null);
    } catch (error) {
      return outcome(null, null, String(error).slice(0, 200));
    }
  });
  const metrics = selectionMetrics(results.map((x) => ({ gold: x.r.gold.decision, decision: decide(x) })));
  const mistakes: Array<Record<string, unknown>> = [];
  for (const x of results) {
    const pred = decide(x);
    const gold = x.r.gold.decision;
    if (pred === null || gold === "either") continue;
    if (pred === "select" && gold === "reject") mistakes.push({ kind: "FP", title: x.r.material.title, score: shownScore(x.scores), stratum: x.r.samplingContext?.samplingStratum ?? null });
    else if (pred === "reject" && gold === "select") mistakes.push({ kind: "FN", title: x.r.material.title, score: shownScore(x.scores), relevance: x.relevance, stratum: x.r.samplingContext?.samplingStratum ?? null });
  }
  const usage = await usageFor(results.flatMap((x) => x.receiptIds));
  const summary = {
    model,
    ...metrics,
    ...usage,
    wallSeconds: Math.round((performance.now() - started) / 1000),
  };
  console.log(JSON.stringify(summary));
  // Threshold sweep keeps valid-output metrics, while coverage and completeAcc charge decisive failures.
  const thresholdCases = results.map((x) => ({ gold: x.r.gold.decision, available: x.error === null, passed: x.relevance === "pass", scores: x.scores }));
  const sweep = [];
  for (let t = defaults.sweep[0]; t <= defaults.sweep[1]; t += 2) {
    sweep.push(selectionThresholdMetrics(thresholdCases, t));
  }
  console.log(sweep.map((s) =>
    `  t=${s.t} acc=${s.acc} completeAcc=${s.completeAcc} coverage=${s.coverage} P=${s.P} R=${s.R} F1=${s.F1} sel=${s.sel}`
  ).join("\n"));
  const cases = results.map((x) => ({
    caseId: x.r.caseId,
    title: x.r.material.title,
    stratum: x.r.samplingContext?.samplingStratum ?? null,
    gold: x.r.gold.decision,
    decision: decide(x),
    score: shownScore(x.scores),
    relevance: x.relevance,
    receiptId: x.receiptIds[0] ?? null,
    error: x.error,
  }));
  report[model] = { summary, sweep, mistakes, cases };
}
const outDir = path.join(REPO_ROOT, ".data/eval");
mkdirSync(outDir, { recursive: true });
const splitName = safeReportNamePart(values.split!);
const file = path.join(outDir, `selection-${splitName}-${sample.length}-${Date.now()}.json`);
const meta = { split: values.split, n: sample.length, seed: Number(values.seed), promptVersion: SELECTION_PROMPT_VERSION, createdAt: new Date().toISOString() };
writeFileSync(file, JSON.stringify({ meta, models: report }, null, 2));
console.log(`report: ${file}`);
if (!values["no-import"]) {
  const run = await importSelectBenchRun({ meta, models: report }, values.label ?? `${values.split} ${sample.length} 条 · ${Object.keys(report).join(" / ")}`, "script:eval-selection");
  console.log(`SelectBench run: ${run.id}`);
}
await closeDb();
