// Builds the v15 board inputs from stored source snapshots: one representative configuration
// per model and unit, board weights from the fixed budgets, eligibility, and the removal
// scenarios used for rank stability.
import { sql } from "../../db.ts";
import { cloakedModel } from "../fetch/identity.ts";
import {
  ANCHORS,
  BOARD_KEYS,
  categoryPolicy,
  OVERALL_POLICY,
  RELEASE_WINDOW_MONTHS,
  SCORING_SOURCES,
  type BoardInput,
  type Policy,
  type RegistryEntry,
  type ScoringSource,
  type SignalRow,
} from "./v15.ts";

/** Rows missing from the newest snapshot may come from one last verified this recently (same protocol). */
export const CARRY_FORWARD_DAYS = 7;
const CONFIGURATION_POLICY = "representative-config-v13";

interface SnapshotRow {
  id: string;
  source_key: string;
  published_at: Date | null;
  fetched_at: Date;
  metadata: Record<string, unknown>;
}

interface ScoreRow {
  snapshot_id: string;
  metric_key: string;
  slug: string;
  name: string;
  released_at: Date | null;
  raw_score: number | null;
  lower_bound: number | null;
  upper_bound: number | null;
  configuration_key: string;
  selected_for_product: boolean;
  metadata: Record<string, unknown>;
}

export interface EvidenceMeta {
  unit: string;
  operator: string;
  protocol: string;
  snapshotId: string;
  verifiedAt: string | null;
  evaluatedAt: string | null;
  publishedAt: string | null;
  configuration: string;
  carriedForward: boolean;
  configurationPolicy: string;
}

export interface RunInputs {
  at: Date;
  snapshotIds: string[];
  boards: BoardInput[];
  evidence: Record<string, EvidenceMeta>;
  sources: Array<{ key: string; weight: number; familyKey: string; categoryKey: string | null; usedInOverall: boolean; usedInCategory: boolean; evidenceBudgetKey: string }>;
  categories: Array<{ key: string; status: "READY" | "INSUFFICIENT"; modelCount: number; metricCount: number; sourceCount: number; sourceSnapshotIds: string[] }>;
}

/** Protocol string: what a score is comparable with (benchmark edition, release, index version). */
export function protocolOf(sourceKey: string, meta: Record<string, unknown>): string {
  const tag =
    meta.intelligenceIndexVersion !== undefined
      ? `intelligenceIndexVersion=${meta.intelligenceIndexVersion}`
      : meta.editionId !== undefined
        ? `editionId=${meta.editionId}${meta.datasetVersion !== undefined ? `;datasetVersion=${meta.datasetVersion}` : ""}`
        : meta.release !== undefined && String(sourceKey).startsWith("livebench")
          ? `release=${meta.release}`
          : meta.benchmarkVersion !== undefined
            ? `benchmarkVersion=${meta.benchmarkVersion}`
            : "published-schema";
  return `${sourceKey}:registered-v13:${tag}`;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === "string" ? new Date(d).toISOString() : null);

/** Latest snapshot per scoring source, or exactly the given ones when reproducing a run. */
async function pickSnapshots(at: Date, snapshotIds?: string[]): Promise<SnapshotRow[]> {
  if (snapshotIds) {
    return sql<SnapshotRow[]>`SELECT id, source_key, published_at, fetched_at, metadata FROM lb_snapshots WHERE id = ANY(${snapshotIds})`;
  }
  const keys = SCORING_SOURCES.map((s) => s.key);
  return sql<SnapshotRow[]>`
    SELECT DISTINCT ON (source_key) id, source_key, published_at, fetched_at, metadata
    FROM lb_snapshots WHERE source_key = ANY(${keys}) AND fetched_at <= ${at}
    ORDER BY source_key, fetched_at DESC`;
}

export async function buildRunInputs(opts: { at?: Date; snapshotIds?: string[] } = {}): Promise<RunInputs> {
  const at = opts.at ?? new Date();
  const snapshots = await pickSnapshots(at, opts.snapshotIds);
  const bySource = new Map(snapshots.map((s) => [s.source_key, s]));

  // Load recent history in one query. Excluded rows must also take their place in history: a newer
  // explicit exclusion is a correction, not an omission that may revive an older eligible run.
  const older = opts.snapshotIds ? [] : await sql<SnapshotRow[]>`
    SELECT s.id, s.source_key, s.published_at, s.fetched_at, s.metadata FROM lb_snapshots s
    JOIN lb_snapshots latest ON latest.id = ANY(${snapshots.map((s) => s.id)}) AND latest.source_key = s.source_key
    WHERE s.fetched_at < latest.fetched_at
      AND coalesce((s.metadata->>'lastSeenAt')::timestamptz, s.fetched_at) >= ${new Date(at.getTime() - CARRY_FORWARD_DAYS * 86400_000)}
    ORDER BY s.fetched_at DESC`;
  const history = [...snapshots, ...older.filter((s) => protocolOf(s.source_key, s.metadata) === protocolOf(s.source_key, bySource.get(s.source_key)!.metadata))];
  const scoreRows = await sql<ScoreRow[]>`
    SELECT c.snapshot_id, c.metric_key, m.slug, m.name, m.released_at, c.raw_score, c.lower_bound, c.upper_bound,
           c.configuration_key, c.selected_for_product, c.metadata
    FROM lb_scores c JOIN lb_models m ON m.id = c.model_id
    WHERE c.snapshot_id = ANY(${history.map((s) => s.id)})
    ORDER BY c.selected_for_product DESC`;
  const rowsBySnapshot = new Map<string, ScoreRow[]>();
  for (const row of scoreRows) (rowsBySnapshot.get(row.snapshot_id) ?? rowsBySnapshot.set(row.snapshot_id, []).get(row.snapshot_id)!).push(row);

  const sourceOf = new Map(SCORING_SOURCES.map((s) => [s.unit, s]));
  const unitRows = new Map<string, Map<string, SignalRow>>();
  const names = new Map<string, string>();
  const released = new Map<string, Date | null>();
  const evidence: Record<string, EvidenceMeta> = {};
  const addRow = (r: ScoreRow, snap: SnapshotRow, carriedForward: boolean) => {
    const src = sourceOf.get(r.metric_key);
    if (!src) return;
    if (!unitRows.has(r.metric_key)) unitRows.set(r.metric_key, new Map());
    // The representative configuration as stored with the row (imported legacy rows also carry it as
    // metadata.configurationIdentity, always equal to the key).
    const configuration = r.configuration_key;
    unitRows.get(r.metric_key)!.set(r.slug, { score: r.raw_score!, modelSlug: r.slug, lowerBound: r.lower_bound, upperBound: r.upper_bound, configuration });
    names.set(r.slug, r.name);
    released.set(r.slug, r.released_at);
    evidence[`${r.metric_key}:${r.slug}`] = {
      unit: r.metric_key,
      operator: src.operator,
      protocol: protocolOf(snap.source_key, snap.metadata),
      snapshotId: snap.id,
      verifiedAt: iso(snap.metadata.lastSeenAt) ?? snap.fetched_at.toISOString(),
      evaluatedAt: iso(r.metadata.measuredAt),
      publishedAt: snap.published_at?.toISOString() ?? null,
      configuration,
      carriedForward,
      configurationPolicy: CONFIGURATION_POLICY,
    };
  };
  const present = new Set<string>();
  for (const snap of history) {
    for (const row of rowsBySnapshot.get(snap.id) ?? []) {
      const key = `${snap.source_key}:${row.metric_key}:${row.slug}`;
      if (present.has(key)) continue;
      present.add(key);
      if (row.selected_for_product && row.raw_score !== null && !cloakedModel(row.slug, row.name)) {
        addRow(row, snap, snap.id !== bySource.get(snap.source_key)!.id);
      }
    }
  }

  const cutoff = new Date(at);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RELEASE_WINDOW_MONTHS);
  const withData = (s: ScoringSource) => s.scoring && unitRows.has(s.unit) && unitRows.get(s.unit)!.size > 0;

  const boards: BoardInput[] = [];
  const categories: RunInputs["categories"] = [];
  for (const board of BOARD_KEYS) {
    // Category weights are shares of the category's whole budget, including sources still awaiting evidence.
    const members = board === "overall" ? SCORING_SOURCES : SCORING_SOURCES.filter((s) => s.category === board);
    const budget = members.reduce((sum, s) => sum + s.weight, 0);
    const active = members.filter(withData);
    if (!active.length) continue;
    const registry: Record<string, RegistryEntry> = {};
    for (const s of active) {
      const snap = bySource.get(s.key);
      registry[s.unit] = {
        family: s.family,
        weight: board === "overall" ? s.weight : s.weight / budget,
        operator: s.operator,
        protocol: protocolOf(s.key, snap?.metadata ?? {}),
        direction: s.direction,
        interval_sd: s.intervalSd,
      };
    }
    const units = active.map((s) => s.unit);
    const policy: Policy = board === "overall" ? OVERALL_POLICY : categoryPolicy(units.length, new Set(active.map((s) => s.operator)).size);
    const qualify = (useUnits: string[]) => qualifyModels(useUnits, registry, unitRows, policy, released, cutoff);
    const models = qualify(units);
    const qualificationScenarios: BoardInput["qualificationScenarios"] = {};
    for (const op of [...new Set(active.map((s) => s.operator))]) {
      const rest = units.filter((u) => registry[u]!.operator !== op);
      const q = qualify(rest);
      qualificationScenarios[`operator:${op}`] = { units: q.length ? rest : [], models: q };
    }
    for (const u of units) {
      const rest = units.filter((x) => x !== u);
      const q = qualify(rest);
      qualificationScenarios[`unit:${u}`] = { units: q.length ? rest : [], models: q };
    }
    const qualified = new Set(models);
    boards.push({
      board,
      names: Object.fromEntries(models.map((m) => [m, names.get(m) ?? m])),
      models,
      policy,
      anchors: ANCHORS,
      signals: units.map((u) => ({
        key: u,
        rows: [...unitRows.get(u)!.values()].filter((r) => qualified.has(r.modelSlug)).sort((a, b) => (a.modelSlug < b.modelSlug ? -1 : 1)),
      })),
      registry,
      qualificationScenarios,
    });
    if (board !== "overall") {
      categories.push({
        key: board,
        status: models.length >= 5 ? "READY" : "INSUFFICIENT",
        modelCount: models.length,
        metricCount: units.length,
        sourceCount: active.length,
        sourceSnapshotIds: active.map((s) => bySource.get(s.key)?.id).filter((x): x is string => !!x),
      });
    }
  }

  return {
    at,
    snapshotIds: snapshots.map((s) => s.id),
    boards,
    evidence,
    sources: SCORING_SOURCES.map((s) => ({
      key: s.key,
      weight: s.weight,
      familyKey: s.family,
      categoryKey: s.category,
      usedInOverall: withData(s),
      usedInCategory: !!s.category && withData(s),
      evidenceBudgetKey: s.budget,
    })),
    categories,
  };
}

/**
 * Eligibility on a set of units: enough sources, families, operators and specialised budgets,
 * direct comparisons with enough reference models, and a release inside the window.
 */
export function qualifyModels(
  units: string[],
  registry: Record<string, RegistryEntry>,
  unitRows: Map<string, Map<string, SignalRow>>,
  policy: Policy,
  released: Map<string, Date | null>,
  cutoff: Date,
): string[] {
  const active = units.filter((u) => registry[u] && registry[u]!.weight > 0);
  const budgetOf = new Map(SCORING_SOURCES.map((s) => [s.unit, s.budget]));
  const has = (slug: string, u: string) => unitRows.get(u)?.has(slug) ?? false;
  const candidates = new Set<string>();
  for (const u of active) for (const slug of unitRows.get(u)?.keys() ?? []) candidates.add(slug);
  const out: string[] = [];
  for (const slug of candidates) {
    const rel = released.get(slug);
    if (rel && rel < cutoff) continue;
    const us = active.filter((u) => has(slug, u));
    if (us.length < policy.sources) continue;
    if (new Set(us.map((u) => registry[u]!.family)).size < policy.families) continue;
    if (new Set(us.map((u) => registry[u]!.operator)).size < policy.operators) continue;
    const specialised = new Set(us.map((u) => budgetOf.get(u)).filter((b) => b && b !== "broad" && b !== "preference"));
    if (specialised.size < policy.categories) continue;
    const anchors = ANCHORS.filter((a) => a !== slug && us.some((u) => has(a, u))).length;
    if (anchors < policy.directAnchors) continue;
    out.push(slug);
  }
  return out.sort();
}
