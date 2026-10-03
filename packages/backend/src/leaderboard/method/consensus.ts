// v17 preserves the observed-evidence order and adds an explicitly relative 0–100 score.
import { fitScores, type ScoreFit } from "./score.ts";
import { reversalCost, solveKemeny } from "./kemeny.ts";
import { validCalibration, type Calibration } from "./calibration.ts";
export { ANCHORS, buildCalibration, validCalibration, CALIBRATION_VERSION } from "./calibration.ts";
export type { Calibration } from "./calibration.ts";

export const METHOD_VERSION = "2026.10-observed-evidence-v17";
export const BUDGETS = [
  { key: "coding", name: "编程", weight: 0.125 },
  { key: "reasoning", name: "数学与推理", weight: 0.125 },
  { key: "knowledge", name: "知识与事实", weight: 0.125 },
  { key: "language", name: "语言理解与指令", weight: 0.125 },
  { key: "writing", name: "写作与表达", weight: 0.125 },
  { key: "vision", name: "视觉理解", weight: 0.125 },
  { key: "professional", name: "行业专业任务", weight: 0.125 },
  { key: "multilingual", name: "中文与多语言", weight: 0.125 },
] as const;

export interface ScoringSource {
  key: string;
  unit: string;
  weight: number;
  family: string;
  operator: string;
  budget: string;
  category: string | null;
  scoring: boolean;
  intervalSd: number | null;
  direction: "HIGHER" | "LOWER";
}

const REGISTERED_SOURCES: ScoringSource[] = [
  { key: "artificial-analysis", unit: "artificial-analysis:intelligence", weight: 0, family: "broad-composite", operator: "artificial-analysis", budget: "broad", category: null, scoring: false, intervalSd: null, direction: "HIGHER" },
  { key: "artificial-analysis-multilingual", unit: "artificial-analysis-multilingual", weight: 0, family: "multilingual", operator: "artificial-analysis", budget: "multilingual", category: null, scoring: false, intervalSd: null, direction: "HIGHER" },
  { key: "arena-text", unit: "arena-text", weight: 0, family: "arena-preference", operator: "arena", budget: "preference", category: null, scoring: false, intervalSd: 1.96, direction: "HIGHER" },
  { key: "arena-webdev", unit: "arena-webdev", weight: 0, family: "arena-preference", operator: "arena", budget: "coding", category: null, scoring: false, intervalSd: 1.96, direction: "HIGHER" },
  { key: "mercor-apex-agents", unit: "mercor-apex-agents:loop-pass-1", weight: 0, family: "professional-office", operator: "mercor", budget: "professional", category: "professional", scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "vals-finance-agent", unit: "vals-finance-agent", weight: 0, family: "professional-finance", operator: "vals-ai", budget: "professional", category: "professional", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "deepswe-v1-1", unit: "deepswe-v1-1", weight: 0, family: "software-engineering", operator: "datacurve", budget: "coding", category: "coding", scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "taptap-maker", unit: "taptap-maker", weight: 0, family: "game-development", operator: "taptap-maker", budget: "coding", category: "coding", scoring: false, intervalSd: 1.96, direction: "HIGHER" },
  { key: "livebench-coding", unit: "livebench-coding:direct", weight: 0, family: "livebench-coding", operator: "livebench", budget: "coding", category: "coding", scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "livebench-coding", unit: "livebench-coding:agentic", weight: 0, family: "livebench-agentic", operator: "livebench", budget: "coding", category: "coding", scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "livebench-reasoning", unit: "livebench-reasoning", weight: 0, family: "livebench-reasoning", operator: "livebench", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "livebench-writing", unit: "livebench-writing", weight: 0, family: "livebench-language", operator: "livebench", budget: "language", category: null, scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "arena-creative-writing", unit: "arena-creative-writing", weight: 0, family: "arena-creative-writing", operator: "arena", budget: "writing", category: null, scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "arena-vision", unit: "arena-vision", weight: 0, family: "arena-vision", operator: "arena", budget: "vision", category: null, scoring: true, intervalSd: 1.96, direction: "HIGHER" },
  { key: "tau-banking", unit: "tau-banking", weight: 0, family: "customer-service-banking", operator: "sierra", budget: "professional", category: "professional", scoring: false, intervalSd: null, direction: "HIGHER" },
  { key: "epoch-simpleqa", unit: "epoch-simpleqa", weight: 0, family: "epoch-simpleqa", operator: "epoch-ai", budget: "knowledge", category: "knowledge", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-gpqa", unit: "epoch-gpqa", weight: 0, family: "epoch-gpqa", operator: "epoch-ai", budget: "knowledge", category: "knowledge", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-frontiermath", unit: "epoch-frontiermath", weight: 0, family: "research-mathematics", operator: "epoch-ai", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-frontiermath-tier4", unit: "epoch-frontiermath-tier4", weight: 0, family: "research-mathematics", operator: "epoch-ai", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-chess", unit: "epoch-chess", weight: 0, family: "epoch-chess", operator: "epoch-ai", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: 1, direction: "HIGHER" },
  { key: "epoch-mystery", unit: "epoch-mystery", weight: 0, family: "epoch-mystery", operator: "epoch-ai", budget: "reasoning", category: "reasoning", scoring: true, intervalSd: 1, direction: "HIGHER" },
  // Prompt-pool independence has not been established for these related creative-writing variants:
  // keep one conservative family budget.
  { key: "eq-creative", unit: "eq-creative", weight: 0, family: "judged-creative-writing", operator: "eq-bench", budget: "writing", category: null, scoring: true, intervalSd: null, direction: "HIGHER" },
  { key: "eq-longform", unit: "eq-longform", weight: 0, family: "judged-creative-writing", operator: "eq-bench", budget: "writing", category: null, scoring: true, intervalSd: null, direction: "HIGHER" },
];

/** Shares are registered in advance, not renormalised over whichever measurements arrived today.
 * The registry lists each piece of evidence once, as one unit; another measurement in a family only
 * divides that family's share. */
export function assignEvidenceWeights(sources: readonly ScoringSource[], board = "overall"): Map<string, number> {
  const members = sources.filter((s) => s.scoring && (board === "overall" || s.category === board));
  const domains = BUDGETS.filter((d) => members.some((s) => s.budget === d.key));
  const domainTotal = board === "overall" ? 1 : domains.reduce((sum, d) => sum + d.weight, 0);
  const result = new Map(sources.map((s) => [s.unit, 0]));
  for (const domain of domains) {
    const inDomain = members.filter((s) => s.budget === domain.key);
    const families = new Set(inDomain.map((s) => s.family));
    for (const family of families) {
      const inFamily = inDomain.filter((s) => s.family === family);
      for (const source of inFamily) result.set(source.unit, domain.weight / domainTotal / families.size / inFamily.length);
    }
  }
  return result;
}
const registeredWeights = assignEvidenceWeights(REGISTERED_SOURCES);
export const SCORING_SOURCES = REGISTERED_SOURCES.map((s) => ({ ...s, weight: registeredWeights.get(s.unit)! }));
export const RELEASE_WINDOW_MONTHS = 18;

export interface Policy { sources: number; families: number; operators: number; categories: number; directAnchors: number }
export const OVERALL_POLICY: Policy = { sources: 3, families: 3, operators: 3, categories: 3, directAnchors: 2 };
export function categoryPolicy(units: number, operators: number): Policy {
  return { sources: Math.min(2, units), families: 1, operators: Math.min(2, operators), categories: 0, directAnchors: 1 };
}
export interface SignalRow {
  score: number; modelSlug: string; lowerBound: number | null; upperBound: number | null; configuration: string; snapshotId?: string;
}
export interface RegistryEntry {
  sourceKey: string;
  budget: string;
  family: string;
  weight: number;
  operator: string;
  protocol: string;
  direction: "HIGHER" | "LOWER";
  interval_sd: number | null;
  calibration: Calibration | null;
}
export interface BoardInput {
  board: string;
  names: Record<string, string>;
  models: string[];
  policy: Policy;
  anchors: string[];
  signals: Array<{ key: string; rows: SignalRow[] }>;
  registry: Record<string, RegistryEntry>;
}
export interface BoardEntry {
  name: string; rank: number; slug: string; score: number | null; coverage: number;
  source_count: number; measurement_count: number; operator_count: number; unknownErrorCount: number;
}
export interface BoardOutput {
  board: string;
  solver: { optimal: boolean; lower_bound: number; absolute_gap: number; reversal_cost: number; numerical_tolerance: number };
  scoring: ScoreFit;
  entries: BoardEntry[];
  comparisons: Record<string, Array<{ net: number; slug: string; shared: number; directCount: number }>>;
  model_count: number; source_count: number; measurement_count: number; active_budget: number;
  connected_components: number; publishable_connectivity: boolean;
  observed_weighted_agreement: number;
  unknown_error_count: number; observed_pair_count: number; tied_pair_count: number;
}
interface Measurement { registry: RegistryEntry; rows: SignalRow[] }
type MatrixInput = Pick<BoardInput, "models" | "signals" | "registry">;
interface NetMatrix {
  models: string[]; index: Map<string, number>; M: Float64Array[]; W: Float64Array[]; shared: Int32Array[];
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** An interval is known only when its interpretation and both bounds were actually supplied. */
export function hasPublishedError(row: Pick<SignalRow, "score" | "lowerBound" | "upperBound">, registry: Pick<RegistryEntry, "interval_sd">): boolean {
  return registry.interval_sd !== null && Number.isFinite(registry.interval_sd) && registry.interval_sd > 0
    && row.lowerBound !== null && row.upperBound !== null
    && Number.isFinite(row.lowerBound) && Number.isFinite(row.upperBound)
    && row.lowerBound <= row.score && row.upperBound >= row.score;
}

/** The board's evidence: each registered unit with a usable share and calibration, over the candidates.
 * The registry lists each piece of evidence once, so a unit is one measurement. */
function measurements(input: MatrixInput): Measurement[] {
  const candidates = new Set(input.models);
  const out: Measurement[] = [];
  for (const signal of [...input.signals].sort((a, b) => compareText(a.key, b.key))) {
    const r = input.registry[signal.key];
    if (!r || !(r.weight > 0) || !Number.isFinite(r.weight) || !validCalibration(r.calibration, r.protocol)) continue;
    const rows = signal.rows.filter((row) => candidates.has(row.modelSlug)).sort((a, b) => compareText(a.modelSlug, b.modelSlug));
    for (const row of rows) if (!Number.isFinite(row.score)) throw new Error(`Non-finite evidence score: ${signal.key}/${row.modelSlug}`);
    if (rows.length) out.push({ registry: r, rows });
  }
  return out;
}

function margin(a: SignalRow, b: SignalRow, r: RegistryEntry): number {
  const difference = (a.score - b.score) * (r.direction === "LOWER" ? -1 : 1);
  return clamp(difference / r.calibration!.scale);
}

export function netMatrix(input: MatrixInput): NetMatrix {
  const models = [...new Set(input.models)].sort(compareText);
  const index = new Map(models.map((m, i) => [m, i]));
  const n = models.length;
  const M = Array.from({ length: n }, () => new Float64Array(n));
  const W = Array.from({ length: n }, () => new Float64Array(n));
  const shared = Array.from({ length: n }, () => new Int32Array(n));
  for (const { registry: r, rows } of measurements(input)) {
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!, b = rows[j]!;
      const ia = index.get(a.modelSlug)!, ib = index.get(b.modelSlug)!;
      const support = r.weight * margin(a, b, r);
      M[ia]![ib]! += support; M[ib]![ia]! -= support;
      W[ia]![ib]! += r.weight; W[ib]![ia]! += r.weight;
      shared[ia]![ib]!++; shared[ib]![ia]!++;
    }
  }
  return { models, index, M, W, shared };
}

function components(W: Float64Array[]): number {
  const seen = new Uint8Array(W.length);
  let count = 0;
  for (let start = 0; start < W.length; start++) {
    if (seen[start]) continue;
    count++;
    const stack = [start]; seen[start] = 1;
    while (stack.length) {
      const node = stack.pop()!;
      for (let next = 0; next < W.length; next++) if (!seen[next] && W[node]![next]! > 0) {
        seen[next] = 1; stack.push(next);
      }
    }
  }
  return count;
}

// The worker remains responsible for the outer round deadline; the optimisation has its own limit.
const SOLVER_LIMIT_SECONDS = 15;

export async function computeBoard(input: BoardInput): Promise<BoardOutput> {
  const net = netMatrix(input);
  const { models, M, W, shared } = net;
  const active = measurements(input);
  const base = await solveKemeny(M, { prefer: [...models.keys()], timeLimitSeconds: SOLVER_LIMIT_SECONDS });
  const order = base.order;
  const scoring = await fitScores(net, order, input.anchors);
  const baseRanks = new Map(order.map((m, p) => [models[m]!, p + 1]));

  const entries: BoardEntry[] = order.map((model, position) => {
    const slug = models[model]!;
    const evidence = active.filter((m) => m.rows.some((r) => r.modelSlug === slug));
    return {
      name: input.names[slug] ?? slug, slug, rank: position + 1, score: scoring.scores[model] ?? null,
      coverage: Math.round(evidence.reduce((sum, m) => sum + m.registry.weight, 0) * 1e9) / 1e9,
      source_count: new Set(evidence.map((m) => m.registry.sourceKey)).size,
      measurement_count: evidence.length,
      operator_count: new Set(evidence.map((m) => m.registry.operator)).size,
      unknownErrorCount: evidence.filter((m) => !hasPublishedError(m.rows.find((r) => r.modelSlug === slug)!, m.registry)).length,
    };
  });
  const comparisons: BoardOutput["comparisons"] = {};
  const top = order.slice(0, 30);
  for (const m of order) comparisons[models[m]!] = top.filter((t) => t !== m).map((t) => ({
    net: M[m]![t]!, slug: models[t]!, shared: W[m]![t]!, directCount: shared[m]![t]!,
  }));
  let agreement = 0, totalWeight = 0;
  for (const measurement of active) {
    const { registry, rows } = measurement;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!, b = rows[j]!;
      const direction = baseRanks.get(a.modelSlug)! < baseRanks.get(b.modelSlug)! ? 1 : -1;
      agreement += registry.weight * (1 + direction * margin(a, b, registry)) / 2;
      totalWeight += registry.weight;
    }
  }
  let observedPairs = 0, tiedPairs = 0;
  for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) if (W[i]![j]! > 0) {
    observedPairs++;
    if (Math.abs(M[i]![j]!) < 1e-12) tiedPairs++;
  }
  const componentCount = components(W);
  return {
    board: input.board,
    solver: { optimal: base.optimal, lower_bound: base.lowerBound, absolute_gap: Math.max(0, base.cost - base.lowerBound), reversal_cost: reversalCost(M, order), numerical_tolerance: base.numericalTolerance },
    scoring, entries, comparisons,
    model_count: models.length,
    source_count: new Set(active.map((m) => m.registry.sourceKey)).size,
    measurement_count: active.length,
    active_budget: active.reduce((sum, m) => sum + m.registry.weight, 0),
    connected_components: componentCount, publishable_connectivity: componentCount === 1,
    observed_weighted_agreement: totalWeight ? agreement / totalWeight : 1,
    unknown_error_count: entries.reduce((sum, e) => sum + e.unknownErrorCount, 0),
    observed_pair_count: observedPairs, tied_pair_count: tiedPairs,
  };
}
