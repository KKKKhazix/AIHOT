// Builds the versioned board inputs from stored source snapshots: one representative configuration
// per model and unit, board weights from the fixed budgets, and eligibility.
import { LEADERBOARD_PUBLIC_BOARDS } from "@aihot/contracts/taxonomy";
import { CALIBRATION_METHOD_VERSION } from "./calibration.ts";
import { sql } from "../../db.ts";
import { admissionOf } from "../fetch/admission.ts";
import { cloakedModel } from "../fetch/identity.ts";
import {
  ANCHORS,
  buildCalibration,
  type Calibration,
  categoryPolicy,
  OVERALL_POLICY,
  RELEASE_WINDOW_MONTHS,
  SCORING_SOURCES,
  type BoardInput,
  type Policy,
  type RegistryEntry,
  type ScoringSource,
  type SignalRow,
} from "./consensus.ts";

/** Rows missing from the newest snapshot may come from one last verified this recently (same protocol). */
export const CARRY_FORWARD_DAYS = 7;

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
  source_model_name: string | null;
  source_published_at: Date | null;
  selection_reason: string | null;
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
}

export interface RunInputs {
  at: Date;
  snapshotIds: string[];
  boards: BoardInput[];
  evidence: Record<string, EvidenceMeta>;
  exclusions: Record<string, string>;
  sources: Array<{ key: string; weight: number }>;
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
            : meta.benchmarkFile !== undefined
              ? `benchmarkFile=${meta.benchmarkFile}`
              : "published-schema";
  const audited = admissionOf(sourceKey, { metadata: meta });
  return `${audited.protocolId ?? sourceKey}:single-model-v16:protocolVersion=${audited.version ?? "unversioned"}:${tag}`;
}

const iso = (d: unknown) => {
  const date = d instanceof Date ? d : typeof d === "string" ? new Date(d) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** Persist the first valid anchor calibration; concurrent workers read the winner of the insert. */
export async function calibrationFor(unit: string, protocol: string, rows: SignalRow[]): Promise<Calibration | null> {
  const [existing] = await sql<{ calibration: Calibration }[]>`SELECT calibration FROM lb_calibrations
    WHERE methodology_version = ${CALIBRATION_METHOD_VERSION} AND unit = ${unit} AND protocol = ${protocol}`;
  if (existing) return existing.calibration;
  const calibration = buildCalibration(protocol, rows);
  if (!calibration) return null;
  await sql`INSERT INTO lb_calibrations (methodology_version, unit, protocol, calibration)
    VALUES (${CALIBRATION_METHOD_VERSION}, ${unit}, ${protocol}, ${sql.json(calibration as never)}) ON CONFLICT DO NOTHING`;
  const [saved] = await sql<{ calibration: Calibration }[]>`SELECT calibration FROM lb_calibrations
    WHERE methodology_version = ${CALIBRATION_METHOD_VERSION} AND unit = ${unit} AND protocol = ${protocol}`;
  return saved!.calibration;
}

/** Scales frozen elsewhere, as the model directory carries them (directory.ts): one already frozen here is kept. */
export async function importCalibrations(rows: ReadonlyArray<{ methodology_version: string; unit: string; protocol: string; calibration: Record<string, unknown> }>): Promise<number> {
  let imported = 0;
  for (const c of rows) {
    const res = await sql`INSERT INTO lb_calibrations (methodology_version, unit, protocol, calibration)
      VALUES (${c.methodology_version}, ${c.unit}, ${c.protocol}, ${sql.json(c.calibration as never)}) ON CONFLICT DO NOTHING`;
    imported += res.count;
  }
  return imported;
}

/** Latest snapshot per scoring source. */
async function pickSnapshots(at: Date): Promise<SnapshotRow[]> {
  const keys = SCORING_SOURCES.map((s) => s.key);
  return sql<SnapshotRow[]>`
    SELECT DISTINCT ON (source_key) id, source_key, published_at, fetched_at, metadata
    FROM lb_snapshots WHERE source_key = ANY(${keys}) AND fetched_at <= ${at}
    ORDER BY source_key, fetched_at DESC`;
}

export async function buildRunInputs(opts: { at?: Date } = {}): Promise<RunInputs> {
  const at = opts.at ?? new Date();
  const snapshots = await pickSnapshots(at);
  const bySource = new Map(snapshots.map((s) => [s.source_key, s]));

  // Load recent history in one query. Excluded rows must also take their place in history: a newer
  // explicit exclusion is a correction, not an omission that may revive an older eligible run.
  const older = await sql<SnapshotRow[]>`
    SELECT s.id, s.source_key, s.published_at, s.fetched_at, s.metadata FROM lb_snapshots s
    JOIN lb_snapshots latest ON latest.id = ANY(${snapshots.map((s) => s.id)}) AND latest.source_key = s.source_key
    WHERE s.fetched_at < latest.fetched_at
      AND coalesce((s.metadata->>'lastSeenAt')::timestamptz, s.fetched_at) >= ${new Date(at.getTime() - CARRY_FORWARD_DAYS * 86400_000)}
    ORDER BY s.fetched_at DESC`;
  const history = [...snapshots, ...older.filter((s) => protocolOf(s.source_key, s.metadata) === protocolOf(s.source_key, bySource.get(s.source_key)!.metadata))];
  const scoreRows = await sql<ScoreRow[]>`
    SELECT c.snapshot_id, c.metric_key, m.slug, m.name, m.released_at, c.raw_score, c.lower_bound, c.upper_bound,
           c.configuration_key, c.source_model_name, c.source_published_at, c.selection_reason, c.selected_for_product, c.metadata
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
  const exclusions: Record<string, string> = {};
  const addRow = (r: ScoreRow, snap: SnapshotRow, carriedForward: boolean) => {
    const admitted = admissionOf(snap.source_key, { sourceModelName: r.source_model_name ?? r.name,
      configurationKey: r.configuration_key, metadata: { ...snap.metadata, ...r.metadata } });
    if (!admitted.eligible) {
      exclusions[`${snap.source_key}:${r.slug}`] = admitted.reason ?? "评测协议尚不可比";
      return;
    }
    const src = sourceOf.get(r.metric_key);
    if (!src) return;
    if (!unitRows.has(r.metric_key)) unitRows.set(r.metric_key, new Map());
    // The representative configuration as stored with the row.
    const configuration = r.configuration_key;
    unitRows.get(r.metric_key)!.set(r.slug, { score: r.raw_score!, modelSlug: r.slug, lowerBound: r.lower_bound, upperBound: r.upper_bound, configuration, snapshotId: snap.id });
    names.set(r.slug, r.name);
    released.set(r.slug, r.released_at);
    evidence[`${r.metric_key}:${r.slug}`] = {
      unit: r.metric_key,
      operator: src.operator,
      protocol: protocolOf(snap.source_key, snap.metadata),
      snapshotId: snap.id,
      verifiedAt: iso(snap.metadata.lastSeenAt) ?? snap.fetched_at.toISOString(),
      evaluatedAt: iso(r.metadata.measuredAt) ?? (snap.source_key.startsWith("epoch-") ? iso(r.source_published_at) : null),
      publishedAt: snap.published_at?.toISOString() ?? null,
      configuration,
      carriedForward,
    };
  };
  const present = new Set<string>();
  for (const snap of history) {
    for (const row of rowsBySnapshot.get(snap.id) ?? []) {
      const key = `${snap.source_key}:${row.metric_key}:${row.slug}`;
      if (present.has(key)) continue;
      present.add(key);
      if (row.selected_for_product && row.raw_score !== null && !cloakedModel(row.slug, row.name)) {
        const carried = snap.id !== bySource.get(snap.source_key)!.id;
        if (row.metric_key === "livebench-coding") {
          for (const [part, field] of [["direct", "Coding"], ["agentic", "Agentic Coding"]]) {
            const value = row.metadata[`livebenchCategoryScore:${field}`];
            if (typeof value === "number" && Number.isFinite(value)) addRow({ ...row, metric_key: `livebench-coding:${part}`, raw_score: value, lower_bound: null, upper_bound: null }, snap, carried);
          }
        } else addRow(row, snap, carried);
      }
    }
  }

  const cutoff = new Date(at);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RELEASE_WINDOW_MONTHS);
  const calibrations = new Map<string, Calibration>();
  for (const src of SCORING_SOURCES.filter(s => s.scoring)) {
    const rows = [...(unitRows.get(src.unit)?.values() ?? [])];
    const protocol = protocolOf(src.key, bySource.get(src.key)?.metadata ?? {});
    const calibration = await calibrationFor(src.unit, protocol, rows);
    if (calibration) calibrations.set(src.unit, calibration);
  }
  const withData = (s: ScoringSource) => s.scoring && calibrations.has(s.unit) && unitRows.has(s.unit) && unitRows.get(s.unit)!.size > 0;

  const boards: BoardInput[] = [];
  for (const board of LEADERBOARD_PUBLIC_BOARDS) {
    // Category weights are shares of the category's whole budget, including sources still awaiting evidence.
    const members = board === "overall" ? SCORING_SOURCES : SCORING_SOURCES.filter((s) => s.category === board);
    const budget = members.reduce((sum, s) => sum + s.weight, 0);
    const active = members.filter(withData);
    if (!active.length) continue;
    const registry: Record<string, RegistryEntry> = {};
    for (const s of active) {
      const snap = bySource.get(s.key);
      registry[s.unit] = {
        sourceKey: s.key,
        family: s.family,
        budget: s.budget,
        calibration: calibrations.get(s.unit) ?? null,
        weight: board === "overall" ? s.weight : s.weight / budget,
        operator: s.operator,
        protocol: protocolOf(s.key, snap?.metadata ?? {}),
        direction: s.direction,
        interval_sd: s.intervalSd,
      };
    }
    const units = active.map((s) => s.unit);
    const policy: Policy = board === "overall" ? OVERALL_POLICY : categoryPolicy(units.length, new Set(active.map((s) => s.operator)).size);
    const models = qualifyModels(units, registry, unitRows, policy, released, cutoff);
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
    });
  }

  return {
    at,
    snapshotIds: snapshots.map((s) => s.id),
    boards,
    evidence,
    exclusions,
    sources: SCORING_SOURCES.map((s) => ({ key: s.key, weight: s.weight })),
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
  const has = (slug: string, u: string) => unitRows.get(u)?.has(slug) ?? false;
  const candidates = new Set<string>();
  for (const u of active) for (const slug of unitRows.get(u)?.keys() ?? []) candidates.add(slug);
  const out: string[] = [];
  for (const slug of candidates) {
    const rel = released.get(slug);
    if (rel && rel < cutoff) continue;
    const us = active.filter((u) => has(slug, u));
    if (new Set(us.map(u => registry[u]!.sourceKey)).size < policy.sources) continue;
    if (new Set(us.map((u) => registry[u]!.family)).size < policy.families) continue;
    if (new Set(us.map((u) => registry[u]!.operator)).size < policy.operators) continue;
    if (new Set(us.map((u) => registry[u]!.budget)).size < policy.categories) continue;
    const anchors = ANCHORS.filter((a) => a !== slug && us.some((u) => has(a, u))).length;
    if (anchors < policy.directAnchors) continue;
    out.push(slug);
  }
  return out.sort();
}
