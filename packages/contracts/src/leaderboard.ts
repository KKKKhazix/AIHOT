// First-party leaderboard DTOs (/api/site/leaderboard*). Not a public API.
import type { LeaderboardBoardKey } from "./taxonomy.ts";

export type LbSourceStatus = "ranked" | "cross_reference" | "observing" | "reference_only" | "awaiting";

export const LB_SOURCE_STATUS_LABELS: Record<LbSourceStatus, string> = {
  ranked: "参与排名",
  cross_reference: "交叉参考",
  observing: "观察中",
  reference_only: "仅供参考",
  awaiting: "等待成绩",
};

export interface LbBrand {
  /** Site-relative logo path, or null when only a monogram is available. */
  src: string | null;
  monogram: string;
  /** Raster marks get a light backing plate in dark mode. */
  raster: boolean;
}

export interface LbPrice {
  currency: "CNY" | "USD";
  /** Per million tokens in RMB (converted at the run's rate when the list price is USD). */
  inputCny: number | null;
  outputCny: number | null;
  cachedCny: number | null;
  /** List price in `currency`. */
  input: number | null;
  output: number | null;
  cached: number | null;
  officialUrl: string | null;
  /** Why a checked model has no prices, e.g. the vendor sells no paid API for it. */
  note: string | null;
}

export interface LbFx {
  rate: number;
  asOf: string;
  sourceName: string;
}

export interface LbRunInfo {
  id: string;
  methodologyVersion: string;
  generatedAt: string;
  fx: LbFx | null;
}

export interface LbModelRef {
  slug: string;
  name: string;
  provider: string | null;
  releasedAt: string | null;
  brand: LbBrand;
}

export interface LbBoardMeta {
  key: LeaderboardBoardKey;
  name: string;
  title: string;
  description: string;
  howToRead: string;
  sourceCount: number;
  operatorCount: number;
}

export interface LbBoardEntry {
  rank: number;
  /** The site's 0–100 relative index; null for a run without the current scoring method. */
  score: number | null;
  model: LbModelRef;
  sourceCount: number;
  coverage: number;
  price: LbPrice | null;
  access: { domestic: boolean; weightsUrl: string | null };
}

export interface LbBoardResponse {
  run: LbRunInfo;
  board: LbBoardMeta;
  entries: LbBoardEntry[];
  /** Additional ranked models needed by the filters, each subset still capped at 30. */
  filterEntries: LbBoardEntry[];
  /** Leaders of the overall/category boards whose evidence does not yet qualify them for this board. */
  pending: Array<{ model: LbModelRef; sources: number }>;
}

export type LbScoreFormat = "percent" | "fraction" | "number";

export interface LbEvidenceItem {
  sourceKey: string;
  sourceName: string;
  /** The evaluator's mark. */
  brand: LbBrand | null;
  officialUrl: string | null;
  usage: string;
  display: string;
  /** e.g. "两项均分" for LiveBench pairs. */
  displayNote: string | null;
  sourceRank: number | null;
  sourceModelName: string | null;
  configurationLabel: string | null;
  selectionReason: string | null;
  upstreamAt: string | null;
  verifiedAt: string | null;
  measuredAt: string | null;
  carriedForward: boolean;
  components: Array<{ label: string; display: string }>;
  componentsNote: string | null;
}

export interface LbEvidenceGroup {
  key: string;
  name: string;
  items: LbEvidenceItem[];
}

export interface LbCategoryResult {
  key: LeaderboardBoardKey;
  name: string;
  rank: number | null;
  score: number | null;
  sourceCount: number;
  coverage: number;
  onBoard: boolean;
}

export interface LbComparisonRow {
  sourceKey: string;
  sourceName: string;
  officialUrl: string | null;
  mine: string;
  theirs: string;
  weight: number;
}

export interface LbComparison {
  model: LbModelRef;
  rank: number;
  net: number;
  sharedWeight: number;
  sharedCount: number;
  hasPage: boolean;
  rows: LbComparisonRow[];
}

export interface LbModelDetail {
  run: LbRunInfo;
  /** The model no longer qualifies for a public board; this is its last published result. */
  historical: boolean;
  model: LbModelRef & { contextWindowTokens: number | null; weightsUrl: string | null };
  price: LbPrice | null;
  overall: {
    rank: number | null;
    score: number | null;
    onBoard: boolean;
    coverage: number;
    missingDimensions: string[];
    unknownErrorCount: number;
  };
  categories: LbCategoryResult[];
  metricCount: number;
  evidence: LbEvidenceGroup[];
  /** Scored evaluations that did publish this model, but only in runs the rules exclude. */
  excluded: Array<{ key: string; name: string; reason: string }>;
  unmeasured: Array<{ key: string; name: string }>;
  comparisons: LbComparison[];
}

export interface LbSourceSummary {
  key: string;
  name: string;
  operator: string;
  description: string;
  status: LbSourceStatus;
  brand: LbBrand | null;
  budget: number | null;
}

export interface LbSourceGroup {
  key: string;
  name: string;
  blurb: string;
  sources: LbSourceSummary[];
}

export interface LbSourcesResponse {
  run: LbRunInfo;
  rankedCount: number;
  totalCount: number;
  groups: LbSourceGroup[];
}

export interface LbSourceRow {
  sourceRank: number | null;
  sourceModelName: string;
  provider: string | null;
  display: string;
  configurationLabel: string | null;
  modelSlug: string | null;
  /** Why the model's result here does not count, when no run of it can represent the model. */
  excluded: string | null;
}

export interface LbSourceDetail {
  run: LbRunInfo;
  source: LbSourceSummary & {
    fullName: string;
    area: string | null;
    officialUrl: string | null;
    what: string;
    usage: string;
    limits: string;
    license: string;
    attribution: string;
  };
  upstreamAt: string | null;
  syncedAt: string | null;
  collected: boolean;
  /** Only sources whose results are public on the site carry rows. */
  rows: LbSourceRow[];
  /** Rows are agent systems (one per configuration), not one representative per model. */
  systemRows: boolean;
  rowsNote: string | null;
}

/** The rules page: each capability budget with the evaluations the run used in it, and the reference models. */
export interface LbRulesData {
  run: LbRunInfo;
  budgets: Array<{ key: string; name: string; weight: number; sources: string[] }>;
  anchors: string[];
}
