// Leaderboard read layer: every leaderboard page reads the latest published run through here.
// Page reads never compute rankings; they only format what the run stored.
import { SITE } from "@aihot/industry/site";
import { LEADERBOARD_PUBLIC_BOARDS, type LeaderboardBoardKey } from "@aihot/contracts/taxonomy";
import type {
  LbBoardEntry,
  LbBoardResponse,
  LbComparison,
  LbConfidence,
  LbEvidenceGroup,
  LbEvidenceItem,
  LbModelDetail,
  LbModelRef,
  LbPrice,
  LbRunInfo,
  LbSourceDetail,
  LbSourceRow,
  LbSourcesResponse,
  LbSourceSummary,
  LbStability,
} from "@aihot/contracts/leaderboard";
import { sql } from "../db.ts";
import { boardSubset, modelAccess } from "./access.ts";
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
  score: number;
  coverage: number | null;
  confidence: string | null;
  metric_count: number | null;
  detail: { stability?: LbStability; sourceCount?: number; operatorCount?: number } | null;
}

interface SignalRow {
  score: number;
  modelSlug: string;
  lowerBound: number | null;
  upperBound: number | null;
  configuration: string;
}

interface RegistryEntry {
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
  modelCount: number;
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
  sourceWeights: Map<string, number>;
  budgets: Array<{ key: string; name: string; weight: number }>;
  anchors: string[];
}

export class NoLeaderboardRun extends Error {}

let cached: { view: RunView; checkedAt: number } | null = null;
let loading: Promise<RunView> | null = null;

async function latestRunId(): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM lb_runs WHERE status = 'published' ORDER BY generated_at DESC, created_at DESC LIMIT 1`;
  return row?.id ?? null;
}

/** The latest published run, re-checked at most once a minute. */
export async function runView(): Promise<RunView> {
  if (cached && Date.now() - cached.checkedAt < 60_000) return cached.view;
  loading ??= refreshRunView().finally(() => { loading = null; });
  return loading;
}

async function refreshRunView(): Promise<RunView> {
  const id = await latestRunId();
  if (!id) throw new NoLeaderboardRun("no published leaderboard run");
  if (cached && cached.view.info.id === id) {
    cached.checkedAt = Date.now();
    return cached.view;
  }
  const view = await buildRunView(id);
  cached = { view, checkedAt: Date.now() };
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
    SELECT board, model_id, rank, score, coverage, confidence, metric_count, detail FROM lb_rankings WHERE run_id = ${runId} ORDER BY board, rank`;
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
      modelCount: entries.length,
    });
  }

  const pageSlugs = new Set<string>();
  for (const key of LEADERBOARD_PUBLIC_BOARDS) {
    const entries = (boards.get(key)?.entries ?? []).map((e) => ({ ...e, access: modelAccess(modelsById.get(e.model_id)!) }));
    for (const e of [...boardSubset(entries), ...boardSubset(entries, true), ...boardSubset(entries, false, true), ...boardSubset(entries, true, true)]) pageSlugs.add(e.slug);
  }

  const priceRows = await sql<{ model_id: string; currency: "CNY" | "USD"; input: number | null; output: number | null; cached_input: number | null; source_url: string | null; verified_on: Date | null }[]>`
    SELECT model_id, currency, input, output, cached_input, source_url, verified_on FROM lb_prices WHERE kind = 'official' AND model_id = ANY(${modelIds})`;
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
        verifiedOn: p.verified_on ? p.verified_on.toISOString().slice(0, 10) : null,
      },
    ]),
  );

  const sourceWeights = new Map<string, number>();
  for (const s of summary.sources ?? []) sourceWeights.set(s.key, Number(s.weight));

  return {
    info,
    snapshotIds: run.source_snapshot_ids ?? [],
    models,
    modelsById,
    prices,
    boards,
    pageSlugs,
    evidence: consensus.evidence ?? {},
    sourceWeights,
    budgets: summary.budgets ?? [],
    anchors: inputs.get("overall")?.anchors ?? [],
  };
}

/** Clears the in-memory run so the next read reloads (after a new run is published). */
export function invalidateLeaderboard() {
  cached = null;
}

function confidenceOf(entry: RankingRow): LbConfidence {
  // Reproduces the published labels: sensitive rankings are low confidence; otherwise broad coverage is high.
  if (entry.detail?.stability?.sensitive) return "LOW";
  return (entry.coverage ?? 0) >= 0.7 ? "HIGH" : "MEDIUM";
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

function boardTabs() {
  return LEADERBOARD_PUBLIC_BOARDS.map((key) => ({
    key,
    name: BOARD_COPY[key].name,
    href: key === "overall" ? "/leaderboard" : `/leaderboard/category/${key}`,
  }));
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
        score: e.score,
        model: modelRef(view, m),
        sourceCount: e.detail?.sourceCount ?? e.metric_count ?? 0,
        coverage: e.coverage ?? 0,
        confidence: confidenceOf(e),
        stability: e.detail?.stability ?? null,
        price: view.prices.get(m.id) ?? null,
        access: modelAccess(m),
      };
    });
  const copy = BOARD_COPY[key];
  return {
    run: view.info,
    board: { ...copy, sourceCount: board.sourceCount, operatorCount: board.operatorCount, modelCount: board.modelCount },
    tabs: boardTabs(),
    entries: boardSubset(entries),
    filterEntries: [...new Map([...boardSubset(entries, true), ...boardSubset(entries, false, true), ...boardSubset(entries, true, true)]
      .filter((e) => e.rank > BOARD_LIMIT).map((e) => [e.model.slug, e])).values()].sort((a, b) => a.rank - b.rank),
  };
}

function signalFormat(unit: string, board: BoardView) {
  const rows = board.signals.get(unit);
  const sample = rows ? rows.values().next().value?.score : null;
  return scoreFormat(sourceKeyOfUnit(unit), sample ?? null);
}

interface ScoreDetailRow {
  snapshot_id: string;
  source_rank: number | null;
  source_model_name: string | null;
  configuration_label: string | null;
  selection_reason: string | null;
  metadata: Record<string, unknown>;
}

function usageLabel(status: string | undefined) {
  if (status === "ranked") return "已计入综合排名";
  if (status === "cross_reference") return "交叉参考";
  return "仅供参考";
}

export async function loadModel(slug: string): Promise<LbModelDetail | null> {
  const view = await runView();
  if (!view.pageSlugs.has(slug)) return null;
  const m = view.models.get(slug);
  if (!m) return null;
  const overall = view.boards.get("overall");
  const overallEntry = overall?.bySlug.get(slug) ?? null;

  const categories = LEADERBOARD_PUBLIC_BOARDS.filter((k) => k !== "overall").map((key) => {
    const e = view.boards.get(key)?.bySlug.get(slug);
    return {
      key,
      name: BOARD_COPY[key].name,
      rank: e?.rank ?? null,
      score: e?.score ?? null,
      sourceCount: e?.detail?.sourceCount ?? e?.metric_count ?? 0,
      onBoard: !!e && e.rank <= BOARD_LIMIT,
    };
  });

  // Evidence: every scored unit of the overall board this model has, grouped like the sources page.
  const units = overall ? Object.entries(overall.registry).filter(([unit, r]) => r.weight > 0 && overall.signals.get(unit)?.has(slug)) : [];
  const metas = units.map(([unit]) => view.evidence[`${unit}:${slug}`]).filter((e): e is EvidenceMeta => !!e);
  const details = metas.length
    ? await sql<ScoreDetailRow[]>`
        SELECT snapshot_id, source_rank, source_model_name, configuration_label, selection_reason, metadata
        FROM lb_scores WHERE model_id = ${m.id} AND snapshot_id = ANY(${[...new Set(metas.map((e) => e.snapshotId))]})`
    : [];
  const detailFor = (meta: EvidenceMeta | undefined) =>
    meta ? details.find((d) => d.snapshot_id === meta.snapshotId && d.metadata.configurationIdentity === meta.configuration) ?? null : null;

  const itemsBySource = new Map<string, LbEvidenceItem>();
  for (const [unit] of units) {
    const sourceKey = sourceKeyOfUnit(unit);
    const reg = registrySource(sourceKey);
    const signal = overall!.signals.get(unit)!.get(slug)!;
    const meta = view.evidence[`${unit}:${slug}`];
    const detail = detailFor(meta);
    const format = signalFormat(unit, overall!);
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
      display: formatScore(signal.score, format),
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
  const scoredSources = new Set(overall ? Object.entries(overall.registry).filter(([, r]) => r.weight > 0).map(([u]) => sourceKeyOfUnit(u)) : []);
  const unmeasured = [...scoredSources]
    .filter((k) => !itemsBySource.has(k))
    .map((k) => ({ key: k, name: registrySource(k)?.source.name ?? k }));

  return {
    run: view.info,
    model: { ...modelRef(view, m), contextWindowTokens: m.context_window_tokens },
    price: view.prices.get(m.id) ?? null,
    overall: {
      rank: overallEntry?.rank ?? null,
      score: overallEntry?.score ?? null,
      onBoard: !!overallEntry && overallEntry.rank <= BOARD_LIMIT,
      confidence: overallEntry ? confidenceOf(overallEntry) : null,
      stability: overallEntry?.detail?.stability ?? null,
    },
    categories,
    metricCount: itemsBySource.size,
    evidence,
    unmeasured,
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
          sourceName: reg?.source.name ?? sourceKey,
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
    const scoreRows = await sql<{ source_rank: number | null; source_model_name: string | null; raw_score: number | null; configuration_label: string | null; model_id: string; slug: string; name: string; provider: string | null; metadata: Record<string, unknown> }[]>`
      SELECT c.source_rank, c.source_model_name, c.raw_score, c.configuration_label, c.model_id, m.slug, m.name, m.provider, c.metadata
      FROM lb_scores c JOIN lb_models m ON m.id = c.model_id
      WHERE c.snapshot_id = ${snapshot.id} ${s.allRows ? sql`` : sql`AND c.selected_for_product`}
      ORDER BY c.source_rank NULLS LAST, c.raw_score DESC NULLS LAST
      LIMIT ${BOARD_LIMIT}`;
    const sample = scoreRows.find((r) => r.raw_score != null)?.raw_score ?? null;
    const format = scoreFormat(key, sample);
    rows = scoreRows.map((r) => ({
      sourceRank: r.source_rank,
      sourceModelName: r.source_model_name ?? r.name,
      provider: r.provider === "其他" ? null : r.provider,
      display: formatScore(r.raw_score, format),
      configurationLabel: r.configuration_label,
      modelSlug: view.pageSlugs.has(r.slug) ? r.slug : null,
    }));
  }
  const lastSeen = typeof snapshot?.metadata.lastSeenAt === "string" ? snapshot.metadata.lastSeenAt : null;
  return {
    run: view.info,
    source: {
      ...summary,
      fullName: s.fullName ?? s.name,
      area: s.area ?? null,
      group: { key: reg.group.key, name: reg.group.name },
      officialUrl: s.officialUrl,
      what: s.what,
      usage: s.usage,
      limits: s.limits,
      license: s.license,
      attribution: s.attribution ?? `成绩由 ${s.operator} 发布，原始分数与 ${SITE.name} 共识分使用不同尺度，不能直接相加。`,
    },
    upstreamAt: showRows ? snapshot.published_at?.toISOString() ?? null : null,
    syncedAt: showRows ? lastSeen ?? snapshot.fetched_at.toISOString() : null,
    collected: showRows,
    rows,
    systemRows: !!s.allRows,
    rowsNote: showRows
      ? s.allRows
        ? "下列为模型搭配不同 Agent 的系统成绩，运行条件不同，仅供参考。每项最多展示 30 条配置，匿名测试型号不展示。"
        : "按固定规则，每个公开模型采用一套代表配置。匿名测试型号不展示，保留原榜名次，每项最多 30 个。"
      : null,
  };
}

export interface LbRulesData {
  run: LbRunInfo;
  budgets: Array<{ key: string; name: string; weight: number; sources: string[] }>;
  anchors: string[];
}

/** Budget table and anchors for the rules page, straight from the run. */
export async function loadRulesData(): Promise<LbRulesData> {
  const view = await runView();
  const run = await sql<{ summary: any }[]>`SELECT summary FROM lb_runs WHERE id = ${view.info.id}`;
  const sources = (run[0]?.summary?.sources ?? []) as Array<{ key: string; evidenceBudgetKey: string }>;
  const order = SOURCE_GROUPS.flatMap((g) => g.sources.map((s) => s.key));
  const budgets = view.budgets.map((b) => ({
    ...b,
    sources: sources
      .filter((s) => s.evidenceBudgetKey === b.key)
      .sort((a, c) => order.indexOf(a.key) - order.indexOf(c.key))
      .map((s) => registrySource(s.key)?.source.name ?? s.key),
  }));
  return { run: view.info, budgets, anchors: view.anchors };
}

/** Public leaderboard URLs for the sitemap. */
export async function leaderboardUrls(): Promise<string[]> {
  try {
    const view = await runView();
    return [
      "/leaderboard",
      ...LEADERBOARD_PUBLIC_BOARDS.filter((k) => k !== "overall").map((k) => `/leaderboard/category/${k}`),
      "/leaderboard/sources",
      "/leaderboard/rules",
      ...SOURCE_GROUPS.flatMap((g) => g.sources.map((s) => `/leaderboard/sources/${s.key}`)),
      ...[...view.pageSlugs].map((slug) => `/leaderboard/${slug}`),
    ];
  } catch {
    return [];
  }
}
