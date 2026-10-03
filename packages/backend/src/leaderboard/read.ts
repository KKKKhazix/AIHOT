// Leaderboard read layer: every leaderboard page reads the latest published run through here.
// Page reads never compute rankings; they only format what the run stored.
import { LEADERBOARD_BOARD_LABELS, LEADERBOARD_PUBLIC_BOARDS, type LeaderboardBoardKey } from "@aihot/contracts/taxonomy";
import type {
  LbBoardEntry,
  LbBoardResponse,
  LbBrand,
  LbComparison,
  LbEvidenceGroup,
  LbEvidenceItem,
  LbModelDetail,
  LbModelRef,
  LbPrice,
  LbRulesData,
  LbRunInfo,
  LbSourceDetail,
  LbSourceRow,
  LbSourcesResponse,
  LbSourceSummary,
} from "@aihot/contracts/leaderboard";
import { sql } from "../db.ts";
import { hasPublishedError } from "./method/consensus.ts";
import { SCORE_VERSION } from "./method/score.ts";
import { admissionOf } from "./fetch/admission.ts";
import { cloakedModel } from "./fetch/identity.ts";
import { boardSubset, modelAccess } from "./access.ts";
import { providerSlugOf } from "./providers.ts";
import {
  BOARD_COPY,
  BOARD_LIMIT,
  formatScore,
  modelBrand,
  registrySource,
  scoreFormat,
  SOURCE_GROUPS,
  sourceBrand,
  sourceKeyOfUnit,
} from "./registry.ts";

interface ModelRow {
  id: string;
  slug: string;
  name: string;
  provider: string | null;
  provider_slug: string | null;
  released_at: Date | null;
  context_window_tokens: number | null;
}

interface RankingRow {
  model_id: string;
  rank: number;
  score: number | null;
  coverage: number | null;
  detail: { scoreVersion?: string; sourceCount?: number; operatorCount?: number; unknownErrorCount?: number } | null;
}

interface SignalRow {
  score: number;
  modelSlug: string;
  lowerBound: number | null;
  upperBound: number | null;
  configuration: string;
}

interface RegistryEntry {
  budget?: string;
  family: string;
  weight: number;
  operator: string;
  protocol: string;
  direction: string;
  interval_sd: number | null;
}

interface EvidenceMeta {
  unit: string;
  operator: string;
  snapshotId: string;
  verifiedAt: string | null;
  evaluatedAt: string | null;
  publishedAt: string | null;
  configuration: string;
  carriedForward: boolean;
}

interface ComparisonRaw {
  net: number;
  slug: string;
  shared: number;
  directCount: number;
}

interface BoardView {
  key: string;
  entries: Array<RankingRow & { slug: string }>;
  bySlug: Map<string, RankingRow & { slug: string }>;
  registry: Record<string, RegistryEntry>;
  signals: Map<string, Map<string, SignalRow>>;
  comparisons: Record<string, ComparisonRaw[]>;
  sourceCount: number;
  operatorCount: number;
}

interface RunView {
  info: LbRunInfo;
  snapshotIds: string[];
  models: Map<string, ModelRow>;
  modelsById: Map<string, ModelRow>;
  prices: Map<string, LbPrice>;
  boards: Map<string, BoardView>;
  pageSlugs: Set<string>;
  evidence: Record<string, EvidenceMeta>;
  exclusions: Record<string, string>;
  /** Scored units each model has evidence in (whether or not it qualified for a board). */
  unitsBySlug: Map<string, string[]>;
  sourceWeights: Map<string, number>;
  budgets: LbRulesData["budgets"];
  anchors: string[];
}

export class NoLeaderboardRun extends Error {}

let cached: { view: RunView; dataAt: string | null; checkedAt: number } | null = null;
let loading: Promise<RunView> | null = null;

/** The latest published run, and when prices or model details (names, dates) last changed between runs. */
async function latestRun(): Promise<{ id: string; dataAt: string | null } | null> {
  const [row] = await sql<{ id: string; data_at: Date | null }[]>`
    SELECT id, greatest((SELECT max(updated_at) FROM lb_prices), (SELECT max(updated_at) FROM lb_models)) AS data_at
    FROM lb_runs WHERE status = 'published' ORDER BY generated_at DESC, created_at DESC LIMIT 1`;
  return row ? { id: row.id, dataAt: row.data_at?.toISOString() ?? null } : null;
}

/** The latest published run with current prices and model details, re-checked at most once a minute. */
export async function runView(): Promise<RunView> {
  if (cached && Date.now() - cached.checkedAt < 60_000) return cached.view;
  loading ??= refreshRunView().finally(() => { loading = null; });
  return loading;
}

async function refreshRunView(): Promise<RunView> {
  const latest = await latestRun();
  if (!latest) throw new NoLeaderboardRun("no published leaderboard run");
  if (cached && cached.view.info.id === latest.id && cached.dataAt === latest.dataAt) {
    cached.checkedAt = Date.now();
    return cached.view;
  }
  const view = await buildRunView(latest.id);
  cached = { view, dataAt: latest.dataAt, checkedAt: Date.now() };
  return view;
}

async function buildRunView(runId: string): Promise<RunView> {
  const [run] = await sql<{ id: string; methodology_version: string; generated_at: Date; source_snapshot_ids: string[]; summary: any }[]>`
    SELECT id, methodology_version, generated_at, source_snapshot_ids, summary FROM lb_runs WHERE id = ${runId}`;
  if (!run) throw new NoLeaderboardRun(runId);
  const summary = run.summary ?? {};
  const consensus = summary.consensus ?? {};
  const fxQuote = summary.fxQuote as { asOf: string; rate: number; sourceName: string } | undefined;
  const info: LbRunInfo = {
    id: run.id,
    methodologyVersion: run.methodology_version,
    generatedAt: run.generated_at.toISOString(),
    fx: fxQuote ? { rate: Number(fxQuote.rate), asOf: fxQuote.asOf, sourceName: fxQuote.sourceName } : null,
  };

  const rankingRows = await sql<Array<RankingRow & { board: string }>>`
    SELECT board, model_id, rank, score, coverage, detail FROM lb_rankings WHERE run_id = ${runId} ORDER BY board, rank`;
  const modelIds = [...new Set(rankingRows.map((r) => r.model_id))];
  const modelRows = await sql<ModelRow[]>`
    SELECT id, slug, name, provider, provider_slug, released_at, context_window_tokens FROM lb_models WHERE id = ANY(${modelIds})`;
  const modelsById = new Map(modelRows.map((m) => [m.id, m]));
  const models = new Map(modelRows.map((m) => [m.slug, m]));

  const inputs = new Map<string, any>((consensus.input ?? []).map((i: any) => [i.board, i]));
  const outputs = new Map<string, any>((consensus.boards ?? []).map((b: any) => [b.board, b]));
  const boards = new Map<string, BoardView>();
  for (const [key, input] of inputs) {
    const entries = rankingRows
      .filter((r) => r.board === key)
      .map((r) => ({ ...r, slug: modelsById.get(r.model_id)?.slug ?? "" }))
      .filter((r) => r.slug);
    const registry = (input.registry ?? {}) as Record<string, RegistryEntry>;
    const signals = new Map<string, Map<string, SignalRow>>();
    for (const s of input.signals ?? []) signals.set(s.key, new Map((s.rows as SignalRow[]).map((row) => [row.modelSlug, row])));
    const active = Object.entries(registry).filter(([, r]) => r.weight > 0);
    const output = outputs.get(key) ?? {};
    boards.set(key, {
      key,
      entries,
      bySlug: new Map(entries.map((e) => [e.slug, e])),
      registry,
      signals,
      comparisons: output.comparisons ?? {},
      sourceCount: new Set(active.map(([unit]) => sourceKeyOfUnit(unit))).size,
      operatorCount: new Set(active.map(([, r]) => r.operator)).size,
    });
  }

  const pageSlugs = new Set<string>();
  for (const key of LEADERBOARD_PUBLIC_BOARDS) {
    const entries = (boards.get(key)?.entries ?? []).map((e) => ({ ...e, access: modelAccess(modelsById.get(e.model_id)!) }));
    for (const e of [...boardSubset(entries), ...boardSubset(entries, true), ...boardSubset(entries, false, true), ...boardSubset(entries, true, true)]) pageSlugs.add(e.slug);
  }

  const priceRows = await sql<{ model_id: string; currency: "CNY" | "USD"; input: number | null; output: number | null; cached_input: number | null; source_url: string | null; note: string | null }[]>`
    SELECT model_id, currency, input, output, cached_input, source_url, note FROM lb_prices WHERE kind = 'official' AND model_id = ANY(${modelIds})`;
  const rate = info.fx?.rate ?? null;
  const toCny = (v: number | null, currency: string) => (v == null ? null : currency === "CNY" ? v : rate ? v * rate : null);
  const prices = new Map<string, LbPrice>(
    priceRows.map((p) => [
      p.model_id,
      {
        currency: p.currency,
        input: p.input,
        output: p.output,
        cached: p.cached_input,
        inputCny: toCny(p.input, p.currency),
        outputCny: toCny(p.output, p.currency),
        cachedCny: toCny(p.cached_input, p.currency),
        officialUrl: p.source_url,
        note: p.note,
      },
    ]),
  );

  const sourceWeights = new Map<string, number>();
  for (const s of summary.sources ?? []) sourceWeights.set(s.key, (sourceWeights.get(s.key) ?? 0) + Number(s.weight));
  const sourceOrder = SOURCE_GROUPS.flatMap((g) => g.sources.map((s) => s.key));
  const overallEvidence = Object.entries(boards.get("overall")?.registry ?? {});
  const budgets = ((summary.budgets ?? []) as Array<{ key: string; name: string; weight: number }>).map((b) => ({
    ...b,
    sources: overallEvidence.filter(([, s]) => s.budget === b.key && s.weight > 0)
      .map(([unit]) => sourceKeyOfUnit(unit))
      .sort((a, c) => sourceOrder.indexOf(a) - sourceOrder.indexOf(c))
      .map((key) => registrySource(key)?.source.name ?? key).filter((name, i, all) => all.indexOf(name) === i),
  }));

  const evidence = (consensus.evidence ?? {}) as Record<string, EvidenceMeta>;
  const unitsBySlug = new Map<string, string[]>();
  for (const key of Object.keys(evidence)) {
    const at = key.lastIndexOf(":");
    const slug = key.slice(at + 1);
    (unitsBySlug.get(slug) ?? unitsBySlug.set(slug, []).get(slug)!).push(key.slice(0, at));
  }

  return {
    info,
    snapshotIds: run.source_snapshot_ids ?? [],
    models,
    modelsById,
    prices,
    boards,
    pageSlugs,
    evidence,
    exclusions: consensus.exclusions ?? {},
    unitsBySlug,
    sourceWeights,
    budgets,
    anchors: inputs.get("overall")?.anchors ?? [],
  };
}

/** Clears the in-memory run so the next read reloads (after a new run is published). */
export function invalidateLeaderboard() {
  cached = null;
}

function evidenceCoverage(view: RunView, board: BoardView | undefined, slug: string): number {
  return Object.entries(board?.registry ?? {}).reduce((sum, [unit, r]) => sum + (view.evidence[`${unit}:${slug}`] ? r.weight : 0), 0);
}

function missingDimensions(view: RunView, board: BoardView, slug: string): string[] {
  const measured = new Set(Object.entries(board.registry).filter(([u]) => !!view.evidence[`${u}:${slug}`]).map(([, r]) => r.budget));
  const relevant = board.key === "overall" ? view.budgets : view.budgets.filter(b => Object.values(board.registry).some(r => r.budget === b.key));
  return relevant.filter(b => !measured.has(b.key)).map(b => b.name);
}

/** Old stored indices retain their old meaning; never silently relabel them as the new score. */
function rating(entry: RankingRow | null | undefined): number | null {
  return entry?.detail?.scoreVersion === SCORE_VERSION && entry.score !== null && Number.isFinite(entry.score) ? entry.score : null;
}

function modelRef(view: RunView, m: ModelRow): LbModelRef {
  return {
    slug: m.slug,
    name: m.name,
    provider: m.provider === "其他" ? null : m.provider,
    releasedAt: m.released_at ? m.released_at.toISOString().slice(0, 10) : null,
    brand: modelBrand(m.slug, m.provider_slug, m.provider, m.name),
  };
}

export async function loadBoard(key: LeaderboardBoardKey): Promise<LbBoardResponse | null> {
  const view = await runView();
  const board = view.boards.get(key);
  if (!board) return null;
  const entries: LbBoardEntry[] = board.entries
    .map((e) => {
      const m = view.modelsById.get(e.model_id)!;
      return {
        rank: e.rank,
        score: rating(e),
        model: modelRef(view, m),
        sourceCount: e.detail?.sourceCount ?? 0,
        coverage: e.coverage ?? 0,
        price: view.prices.get(m.id) ?? null,
        access: modelAccess(m),
      };
    });
  return {
    run: view.info,
    board: { key, name: LEADERBOARD_BOARD_LABELS[key], ...BOARD_COPY[key], sourceCount: board.sourceCount, operatorCount: board.operatorCount },
    entries: boardSubset(entries),
    filterEntries: [...new Map([...boardSubset(entries, true), ...boardSubset(entries, false, true), ...boardSubset(entries, true, true)]
      .filter((e) => e.rank > BOARD_LIMIT).map((e) => [e.model.slug, e])).values()].sort((a, b) => a.rank - b.rank),
    pending: pendingModels(view, board),
  };
}

/**
 * The mark of a company's best model on the overall board that readers can open (it has a page), for
 * its topic: null when it has none there or no run is published.
 */
export async function providerMark(providerSlug: string): Promise<LbBrand | null> {
  let view: RunView;
  try {
    view = await runView();
  } catch (error) {
    if (error instanceof NoLeaderboardRun) return null;
    throw error;
  }
  const best = (view.boards.get("overall")?.entries ?? [])
    .find((e) => view.pageSlugs.has(e.slug) && providerSlugOf(view.modelsById.get(e.model_id)!) === providerSlug);
  return best ? modelRef(view, view.modelsById.get(best.model_id)!).brand : null;
}

/**
 * Leading overall models a category board does not rank yet (too few of its evaluations have tested
 * them), so a reader can tell a missing flagship from an oversight.
 */
function pendingModels(view: RunView, board: BoardView): LbBoardResponse["pending"] {
  const units = Object.entries(board.registry).filter(([, r]) => r.weight > 0).map(([unit]) => unit);
  const candidates = board.key === "overall"
    ? [...new Map(LEADERBOARD_PUBLIC_BOARDS.filter(k => k !== "overall")
      .flatMap(k => (view.boards.get(k)?.entries ?? []).filter(e => e.rank <= 10)).map(e => [e.slug, e])).values()]
    : view.boards.get("overall")?.entries ?? [];
  return candidates
    .filter((e) => e.rank <= 10 && !board.bySlug.has(e.slug))
    .map((e) => ({
      model: modelRef(view, view.modelsById.get(e.model_id)!),
      sources: new Set(units.filter((u) => view.evidence[`${u}:${e.slug}`]).map(sourceKeyOfUnit)).size,
    }));
}

function signalFormat(unit: string, board: BoardView) {
  const rows = board.signals.get(unit);
  const sample = rows ? rows.values().next().value?.score : null;
  return scoreFormat(sourceKeyOfUnit(unit), sample ?? null);
}

interface ScoreDetailRow {
  metric_key: string;
  snapshot_id: string;
  configuration_key: string;
  raw_score: number | null;
  lower_bound: number | null;
  upper_bound: number | null;
  source_rank: number | null;
  source_model_name: string | null;
  configuration_label: string | null;
  selection_reason: string | null;
  metadata: Record<string, unknown>;
}

function usageLabel(status: string | undefined) {
  if (status === "ranked") return "综合比较证据";
  if (status === "cross_reference") return "交叉参考";
  return "仅供参考";
}

export async function loadModel(slug: string): Promise<LbModelDetail | null> {
  let view = await runView();
  let historical = false;
  // A published model URL survives both dropping below the display limit and later losing
  // eligibility. Historical reads keep their original date and never replace the current-run cache.
  if (!LEADERBOARD_PUBLIC_BOARDS.some((key) => view.boards.get(key)?.bySlug.has(slug))) {
    const [past] = await sql<{ run_id: string }[]>`
      SELECT r.run_id FROM lb_rankings r JOIN lb_runs b ON b.id = r.run_id JOIN lb_models m ON m.id = r.model_id
      WHERE m.slug = ${slug} AND b.status = 'published' AND r.board = ANY(${[...LEADERBOARD_PUBLIC_BOARDS]})
      ORDER BY b.generated_at DESC, b.created_at DESC LIMIT 1`;
    if (!past) return null;
    view = await buildRunView(past.run_id);
    historical = true;
  }
  const m = view.models.get(slug);
  if (!m || cloakedModel(m.slug, m.name)) return null;
  const overall = view.boards.get("overall");
  const overallEntry = overall?.bySlug.get(slug) ?? null;

  const categories = LEADERBOARD_PUBLIC_BOARDS.filter((k) => k !== "overall").map((key) => {
    const e = view.boards.get(key)?.bySlug.get(slug);
    return {
      key,
      name: LEADERBOARD_BOARD_LABELS[key],
      rank: e?.rank ?? null,
      score: rating(e),
      coverage: e?.coverage ?? evidenceCoverage(view, view.boards.get(key), slug),
      sourceCount: e?.detail?.sourceCount ?? new Set(Object.keys(view.boards.get(key)?.registry ?? {}).filter(u => view.evidence[`${u}:${slug}`]).map(sourceKeyOfUnit)).size,
      onBoard: !!e && e.rank <= BOARD_LIMIT,
    };
  });

  // Evidence: every scored unit this run holds for the model, whichever boards it qualified for (a model
  // ranked only on a category board has no overall signals), grouped like the sources page.
  const scoredUnits = new Set(overall ? Object.entries(overall.registry).filter(([, r]) => r.weight > 0).map(([unit]) => unit) : []);
  const units = (view.unitsBySlug.get(slug) ?? []).filter((u) => scoredUnits.has(u));
  const metas = units.map((unit) => view.evidence[`${unit}:${slug}`]).filter((e): e is EvidenceMeta => !!e);
  const details = metas.length
    ? await sql<ScoreDetailRow[]>`
        SELECT metric_key, snapshot_id, configuration_key, raw_score, lower_bound, upper_bound, source_rank, source_model_name, configuration_label, selection_reason, metadata
        FROM lb_scores WHERE model_id = ${m.id} AND snapshot_id = ANY(${[...new Set(metas.map((e) => e.snapshotId))]})`
    : [];
  const detailFor = (meta: EvidenceMeta | undefined) =>
    meta ? details.find((d) => d.snapshot_id === meta.snapshotId && d.configuration_key === meta.configuration && d.metric_key === (meta.unit.startsWith("livebench-coding:") ? "livebench-coding" : meta.unit)) ?? null : null;

  const itemsBySource = new Map<string, LbEvidenceItem>();
  for (const unit of units) {
    const sourceKey = sourceKeyOfUnit(unit);
    const reg = registrySource(sourceKey);
    const meta = view.evidence[`${unit}:${slug}`];
    const detail = detailFor(meta);
    const score = detail?.raw_score ?? null;
    if (score === null) continue;
    const sample = overall?.signals.get(unit)?.values().next().value?.score;
    const format = scoreFormat(sourceKey, sample ?? score);
    // LiveBench pairs keep their published order ("Language + IF").
    const order = String(detail?.metadata.categories ?? "").split(" + ");
    const components = Object.entries(detail?.metadata ?? {})
      .filter(([k]) => k.startsWith("livebenchCategoryScore:"))
      .map(([k, v]) => ({ label: k.slice("livebenchCategoryScore:".length), display: formatScore(Number(v), "percent") }))
      .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    itemsBySource.set(sourceKey, {
      sourceKey,
      sourceName: reg?.source.name ?? sourceKey,
      brand: reg ? sourceBrand(reg.source) : null,
      officialUrl: reg?.source.officialUrl ?? null,
      usage: usageLabel(reg?.source.status),
      display: formatScore(score, format),
      displayNote: reg?.source.components?.label ?? null,
      sourceRank: detail?.source_rank ?? null,
      sourceModelName: detail?.source_model_name ?? null,
      configurationLabel: detail?.configuration_label ?? null,
      selectionReason: detail?.selection_reason ?? null,
      upstreamAt: meta?.publishedAt ?? null,
      verifiedAt: meta?.verifiedAt ?? null,
      measuredAt: meta?.evaluatedAt ?? null,
      carriedForward: meta?.carriedForward ?? false,
      components,
      componentsNote: components.length ? reg?.source.components?.note ?? null : null,
    });
  }
  const evidence: LbEvidenceGroup[] = SOURCE_GROUPS.map((g) => ({
    key: g.key,
    name: g.name,
    items: g.sources.map((s) => itemsBySource.get(s.key)).filter((i): i is LbEvidenceItem => !!i),
  })).filter((g) => g.items.length > 0);
  // A scored evaluation without evidence either never tested the model, or published only runs the rules
  // exclude (another model finishing some tasks, a pre-release build): say which.
  const missing = [...new Set([...scoredUnits].map(sourceKeyOfUnit))].filter((k) => !itemsBySource.has(k));
  const excludedRows = missing.length
    ? await sql<{ metric_key: string; selection_reason: string | null }[]>`
        SELECT DISTINCT ON (metric_key) metric_key, selection_reason FROM lb_scores
        WHERE model_id = ${m.id} AND snapshot_id = ANY(${view.snapshotIds}) AND NOT selected_for_product
        ORDER BY metric_key, configuration_priority DESC`
    : [];
  const reasons = new Map(excludedRows.map((r) => [sourceKeyOfUnit(r.metric_key), r.selection_reason ?? "该配置不能代表单个公开模型。"]));
  for (const k of missing) if (view.exclusions[`${k}:${slug}`]) reasons.set(k, view.exclusions[`${k}:${slug}`]!);
  const nameOf = (k: string) => registrySource(k)?.source.name ?? k;
  // A run stores the unknown-error count only for the models it ranks overall; any other model's
  // count comes from its own results, by the method's rule.
  const publishedError = (unit: string) => {
    const row = detailFor(view.evidence[`${unit}:${slug}`]);
    return row?.raw_score != null && hasPublishedError({ score: row.raw_score, lowerBound: row.lower_bound, upperBound: row.upper_bound }, overall!.registry[unit]!);
  };

  return {
    run: view.info,
    historical,
    model: { ...modelRef(view, m), contextWindowTokens: m.context_window_tokens, weightsUrl: modelAccess(m).weightsUrl },
    price: view.prices.get(m.id) ?? null,
    overall: {
      rank: overallEntry?.rank ?? null,
      score: rating(overallEntry),
      onBoard: !!overallEntry && overallEntry.rank <= BOARD_LIMIT,
      coverage: overallEntry?.coverage ?? evidenceCoverage(view, overall, slug),
      unknownErrorCount: overallEntry?.detail?.unknownErrorCount ?? units.filter((unit) => !publishedError(unit)).length,
      missingDimensions: overall ? missingDimensions(view, overall, slug) : view.budgets.map(b => b.name),
    },
    categories,
    metricCount: itemsBySource.size,
    evidence,
    excluded: missing.filter((k) => reasons.has(k)).map((k) => ({ key: k, name: nameOf(k), reason: reasons.get(k)! })),
    unmeasured: missing.filter((k) => !reasons.has(k)).map((k) => ({ key: k, name: nameOf(k) })),
    comparisons: overall && overallEntry ? nearbyComparisons(view, overall, slug, overallEntry.rank) : [],
  };
}

function nearbyComparisons(view: RunView, board: BoardView, slug: string, rank: number): LbComparison[] {
  const raw = board.comparisons[slug] ?? [];
  const ranked = raw
    .map((c) => ({ c, other: board.bySlug.get(c.slug) }))
    .filter((x): x is { c: ComparisonRaw; other: RankingRow & { slug: string } } => !!x.other)
    .sort((a, b) => Math.abs(a.other.rank - rank) - Math.abs(b.other.rank - rank) || a.other.rank - b.other.rank)
    .slice(0, 5);
  return ranked.map(({ c, other }) => {
    const om = view.modelsById.get(other.model_id)!;
    const rows = Object.entries(board.registry)
      .filter(([unit, r]) => r.weight > 0 && board.signals.get(unit)?.has(slug) && board.signals.get(unit)?.has(c.slug))
      .map(([unit, r]) => {
        const rowsOf = board.signals.get(unit)!;
        const format = signalFormat(unit, board);
        const sourceKey = sourceKeyOfUnit(unit);
        const reg = registrySource(sourceKey);
        return {
          sourceKey,
          sourceName: `${reg?.source.name ?? sourceKey}${unit.endsWith(":direct") ? " · 直接编程" : unit.endsWith(":agentic") ? " · 工具编程" : ""}`,
          officialUrl: reg?.source.officialUrl ?? null,
          mine: formatScore(rowsOf.get(slug)!.score, format),
          theirs: formatScore(rowsOf.get(c.slug)!.score, format),
          weight: r.weight,
        };
      });
    const order = new Map(SOURCE_GROUPS.flatMap((g) => g.sources.map((s) => s.key)).map((k, i) => [k, i]));
    rows.sort((a, b) => (order.get(a.sourceKey) ?? 999) - (order.get(b.sourceKey) ?? 999));
    return {
      model: modelRef(view, om),
      rank: other.rank,
      net: c.net,
      sharedWeight: c.shared,
      sharedCount: rows.length,
      hasPage: view.pageSlugs.has(c.slug),
      rows,
    };
  });
}

function sourceSummary(view: RunView, key: string): LbSourceSummary | null {
  const reg = registrySource(key);
  if (!reg) return null;
  const s = reg.source;
  return {
    key: s.key,
    name: s.name,
    operator: s.operator,
    description: s.description,
    status: s.status,
    brand: sourceBrand(s),
    budget: s.status === "ranked" || s.status === "awaiting" ? view.sourceWeights.get(s.key) ?? null : null,
  };
}

export async function loadSources(): Promise<LbSourcesResponse> {
  const view = await runView();
  const groups = SOURCE_GROUPS.map((g) => ({
    key: g.key,
    name: g.name,
    blurb: g.blurb,
    sources: g.sources.map((s) => sourceSummary(view, s.key)!),
  }));
  const all = groups.flatMap((g) => g.sources);
  return { run: view.info, rankedCount: all.filter((s) => s.status === "ranked").length, totalCount: all.length, groups };
}

const PUBLIC_ROW_STATUSES = new Set(["ranked", "cross_reference", "reference_only"]);

export async function loadSource(key: string): Promise<LbSourceDetail | null> {
  const reg = registrySource(key);
  if (!reg) return null;
  const view = await runView();
  const summary = sourceSummary(view, key)!;
  const s = reg.source;

  const snapshots = await sql<{ id: string; published_at: Date | null; fetched_at: Date; metadata: Record<string, unknown> }[]>`
    SELECT id, published_at, fetched_at, metadata FROM lb_snapshots WHERE source_key = ${key}
    ORDER BY (id = ANY(${view.snapshotIds})) DESC, fetched_at DESC LIMIT 1`;
  const snapshot = snapshots[0] ?? null;
  const showRows = !!snapshot && PUBLIC_ROW_STATUSES.has(s.status);

  let rows: LbSourceRow[] = [];
  if (showRows) {
    type ScoreRow = { metadata: Record<string,unknown>; configuration_key: string; source_rank: number | null; source_model_name: string | null; raw_score: number | null; configuration_label: string | null; model_id: string; slug: string; name: string; provider: string | null; selected_for_product: boolean; selection_reason: string | null };
    // One row per model: its representative run, or — when the rules exclude every run of it (another
    // model finishing some tasks, a pre-release build) — its top run, marked as not counted.
    const scoreRows = s.allRows
      ? await sql<ScoreRow[]>`
          SELECT c.metadata, c.configuration_key, c.source_rank, c.source_model_name, c.raw_score, c.configuration_label, c.model_id, m.slug, m.name, m.provider, c.selected_for_product, c.selection_reason
          FROM lb_scores c JOIN lb_models m ON m.id = c.model_id
          WHERE c.snapshot_id = ${snapshot.id}
          ORDER BY c.source_rank NULLS LAST, c.raw_score DESC NULLS LAST
          LIMIT ${BOARD_LIMIT * 2}`
      : await sql<ScoreRow[]>`
          SELECT * FROM (
            SELECT DISTINCT ON (c.model_id, c.metric_key) c.metadata, c.configuration_key, c.source_rank, c.source_model_name, c.raw_score, c.configuration_label, c.model_id, m.slug, m.name, m.provider, c.selected_for_product, c.selection_reason
            FROM lb_scores c JOIN lb_models m ON m.id = c.model_id
            WHERE c.snapshot_id = ${snapshot.id} AND c.raw_score IS NOT NULL
            ORDER BY c.model_id, c.metric_key, c.selected_for_product DESC, c.configuration_priority DESC NULLS LAST
          ) best
          ORDER BY source_rank NULLS LAST, raw_score DESC NULLS LAST
          LIMIT ${BOARD_LIMIT * 2}`;
    // Anonymous test identities are not shown (the rules page says so), whatever the snapshot stored.
    const shownRows = scoreRows.filter((r) => !cloakedModel(r.source_model_name, r.slug, r.name)).slice(0, BOARD_LIMIT);
    const sample = shownRows.find((r) => r.raw_score != null)?.raw_score ?? null;
    const format = scoreFormat(key, sample);
    rows = shownRows.map((r) => ({
      sourceRank: r.source_rank,
      sourceModelName: r.source_model_name ?? r.name,
      provider: r.provider === "其他" ? null : r.provider,
      display: formatScore(r.raw_score, format),
      configurationLabel: r.configuration_label,
      modelSlug: view.pageSlugs.has(r.slug) ? r.slug : null,
      excluded: s.allRows ? null : !r.selected_for_product ? r.selection_reason ?? "该配置不能代表单个公开模型。"
        : admissionOf(key, {sourceModelName: r.source_model_name ?? r.name, configurationKey: r.configuration_key, metadata: {...snapshot.metadata,...r.metadata}}).reason,
    }));
  }
  const lastSeen = typeof snapshot?.metadata.lastSeenAt === "string" ? snapshot.metadata.lastSeenAt : null;
  return {
    run: view.info,
    source: {
      ...summary,
      fullName: s.fullName ?? s.name,
      area: s.area ?? null,
      officialUrl: s.officialUrl,
      what: s.what,
      usage: s.usage,
      limits: s.limits,
      license: s.license,
      attribution: s.attribution ?? `成绩由 ${s.operator} 发布，各项原始分数使用不同尺度，不能直接相加；参考位次采用公开的分差标准化规则。`,
    },
    upstreamAt: showRows ? snapshot.published_at?.toISOString() ?? null : null,
    syncedAt: showRows ? lastSeen ?? snapshot.fetched_at.toISOString() : null,
    collected: showRows,
    rows,
    systemRows: !!s.allRows,
    rowsNote: showRows
      ? s.allRows
        ? "下列为模型搭配不同 Agent 的系统成绩，运行条件不同，仅供参考。每项最多展示 30 条配置，匿名测试型号不展示。"
        : "按固定规则，每个公开模型采用一套代表配置；没有可采用配置的模型标为未计入并写明原因。匿名测试型号不展示，保留原榜名次，每项最多 30 个。"
      : null,
  };
}

/** Budget table and anchors for the rules page, straight from the run. */
export async function loadRulesData(): Promise<LbRulesData> {
  const view = await runView();
  return { run: view.info, budgets: view.budgets, anchors: view.anchors };
}

/** Models readers can see on a board (with its filters) that show a monogram because no mark matches them. */
export async function unmarkedBoardModels(): Promise<string[]> {
  const view = await runView();
  return [...view.pageSlugs].map((slug) => view.models.get(slug)).filter((m): m is ModelRow => !!m && !modelRef(view, m).brand.src).map((m) => m.name);
}

/** For the sitemap: every source page and every model page readers can open; none before a run is published. */
export async function leaderboardDetailUrls(): Promise<string[]> {
  try {
    const view = await runView();
    return [
      ...SOURCE_GROUPS.flatMap((g) => g.sources.map((s) => `/leaderboard/sources/${s.key}`)),
      ...[...view.pageSlugs].map((slug) => `/leaderboard/${slug}`),
    ];
  } catch {
    return [];
  }
}
