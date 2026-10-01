// Turns a fetch result into a snapshot: resolve identities, choose each model's representative row per
// metric by the fixed configuration priority (never by score), and write a new snapshot only when the
// content changed — an unchanged upstream just records that it was seen again.
import { createId } from "@paralleldrive/cuid2";
import { sql } from "../../db.ts";
import { sha256, stableJson } from "../../lib/ids.ts";
import { REASONS } from "./configuration.ts";
import { cloakedModel, IdentityResolver, modelSlug } from "./identity.ts";
import { competitionRanks } from "./rank.ts";
import type { FetchResult, ParsedRow } from "./types.ts";

/** The configuration key as stored: tier or system key, then the source's own name for the run. */
export function storedConfigurationKey(r: ParsedRow): string {
  return r.configurationKey ?? `${r.configuration.key}@${r.keyName ?? r.sourceModelName}`;
}

export interface ResolvedRow extends ParsedRow {
  modelId: string;
  selected: boolean;
  selectionReason: string;
}

/**
 * Representative row per (model, metric): eligible rows only, highest priority, then first-party; among
 * equal configurations, the row the source names in slug form, then the one named like the model itself,
 * then the shorter name.
 */
export function selectRepresentatives(rows: Array<ParsedRow & { modelId: string }>, modelSlugs: Map<string, string> = new Map()): ResolvedRow[] {
  const groups = new Map<string, Array<ParsedRow & { modelId: string }>>();
  for (const r of rows) {
    const k = `${r.modelId}\u0000${r.metricKey}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: ResolvedRow[] = [];
  for (const group of groups.values()) {
    const cloaked = (r: ParsedRow & { modelId: string }) => cloakedModel(r.sourceModelName, modelSlugs.get(r.modelId));
    const eligible = group.filter((r) => !r.configuration.ineligible && !cloaked(r));
    const slugShaped = (r: ParsedRow) => Number(/^[a-z0-9-]+$/.test(r.sourceModelName));
    const selfNamed = (r: ParsedRow & { modelId: string }) => Number(modelSlug(r.sourceModelName) === modelSlugs.get(r.modelId));
    const best = [...eligible].sort(
      (a, b) =>
        b.configuration.rank - a.configuration.rank ||
        Number(b.configuration.kind === "FIRST_PARTY") - Number(a.configuration.kind === "FIRST_PARTY") ||
        slugShaped(b) - slugShaped(a) ||
        selfNamed(b) - selfNamed(a) ||
        a.sourceModelName.length - b.sourceModelName.length ||
        (a.sourceModelName < b.sourceModelName ? -1 : a.sourceModelName > b.sourceModelName ? 1 : 0),
    )[0];
    for (const r of group) {
      const selected = r === best;
      const scaffolded = r.configuration.kind === "SCAFFOLDED";
      const selectionReason = r.configuration.ineligible
        ? r.configuration.ineligible
        : cloaked(r)
          ? REASONS.cloaked
        : selected
          ? scaffolded ? REASONS.scaffoldedSelected : r.configuration.kind === "FIRST_PARTY" ? REASONS.firstParty : REASONS.sourceDefault
          : scaffolded ? REASONS.scaffoldedLower : REASONS.lowerPriority;
      out.push({ ...r, selected, selectionReason });
    }
  }
  return out;
}

/**
 * The rank the source's own table shows, for sources that do not state one: every row of the metric
 * (all configurations) in competition order. All fetched metrics are higher-is-better.
 */
function withSourceRanks(rows: ParsedRow[]): ParsedRow[] {
  const byMetric = new Map<string, ParsedRow[]>();
  for (const r of rows) (byMetric.get(r.metricKey) ?? byMetric.set(r.metricKey, []).get(r.metricKey)!).push(r);
  const ranked = new Map<ParsedRow, number>();
  for (const group of byMetric.values()) {
    if (group.some((r) => r.sourceRank != null)) continue;
    const ranks = competitionRanks(group.map((r) => r.rawScore));
    group.forEach((r, i) => ranked.set(r, ranks[i]!));
  }
  return rows.map((r) => (ranked.has(r) ? { ...r, sourceRank: ranked.get(r)! } : r));
}

/** A source occasionally lists the same run twice (same name and settings); the first, higher-placed row stands. */
function firstPerConfiguration(rows: ParsedRow[]): ParsedRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${storedConfigurationKey(r)}\u0000${r.metricKey}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function resolveRows(result: FetchResult, dryRun = false): Promise<{ rows: ResolvedRow[]; newModels: Array<{ id: string; slug: string; name: string }> }> {
  const resolver = await new IdentityResolver(result.sourceKey, dryRun).load();
  const withIds: Array<ParsedRow & { modelId: string }> = [];
  for (const r of withSourceRanks(firstPerConfiguration(result.rows))) {
    const modelId = await resolver.resolve([r.sourceModelName, ...(r.altNames ?? [])], r.baseName, { organization: r.organization, releasedAt: r.releasedAt });
    withIds.push({ ...r, modelId });
  }
  const ids = [...new Set(withIds.map((r) => r.modelId))];
  const slugs = new Map((await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models WHERE id IN ${sql(ids.length ? ids : [""])}`).map((m) => [m.id, m.slug]));
  for (const m of resolver.newModels) slugs.set(m.id, m.slug);
  return { rows: selectRepresentatives(withIds, slugs), newModels: resolver.newModels };
}

function contentHash(result: FetchResult, rows: ResolvedRow[]): string {
  const canon = rows
    .map((r) => stableJson([
      r.sourceModelName, storedConfigurationKey(r), r.metricKey, r.metricName, r.rawScore,
      r.lowerBound ?? null, r.upperBound ?? null, r.modelId, r.selected, r.selectionReason,
      r.configuration.label, r.configuration.kind, r.configuration.priority,
      r.sourceRank ?? null, r.sampleSize ?? null, r.organization ?? null,
      r.sourcePublishedAt ?? null, r.metadata ?? {},
    ]))
    .sort();
  // A corrected rank/date or a new benchmark edition is new evidence even if scores stayed equal.
  return sha256(stableJson({
    sourceName: result.sourceName, sourceUrl: result.sourceUrl, license: result.license,
    attributionUrl: result.attributionUrl, publishedAt: result.publishedAt, metadata: result.metadata, rows: canon,
  }));
}

export async function storeSnapshot(result: FetchResult): Promise<{ snapshotId: string; changed: boolean; rows: number; selected: number; newModels: number }> {
  const { rows, newModels } = await resolveRows(result);
  const hash = contentHash(result, rows);
  const now = new Date();
  const [latest] = await sql<{ id: string; content_hash: string; metadata: Record<string, unknown> }[]>`
    SELECT id, content_hash, metadata FROM lb_snapshots WHERE source_key = ${result.sourceKey} ORDER BY fetched_at DESC LIMIT 1`;
  if (latest && latest.content_hash === hash) {
    await sql`UPDATE lb_snapshots SET metadata = metadata || ${sql.json({ lastSeenAt: now.toISOString() })} WHERE id = ${latest.id}`;
    return { snapshotId: latest.id, changed: false, rows: rows.length, selected: rows.filter((r) => r.selected).length, newModels: newModels.length };
  }
  const id = createId();
  const selected = rows.filter((r) => r.selected);
  const metadata = {
    ...result.metadata,
    parserVersion: "next-1",
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    rawRowCount: result.rows.length,
    configurationRecordCount: rows.length,
    metricModelCounts: [...new Set(selected.map((r) => r.metricKey))].map((m) => `${m}:${selected.filter((r) => r.metricKey === m).length}`).join(","),
    newModelCount: newModels.length,
  };
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO lb_snapshots (id, source_key, source_name, source_url, license, attribution_url, content_hash, published_at, fetched_at, record_count, metadata)
      VALUES (${id}, ${result.sourceKey}, ${result.sourceName}, ${result.sourceUrl}, ${result.license}, ${result.attributionUrl}, ${hash},
              ${result.publishedAt}, ${now}, ${selected.length}, ${tx.json(metadata as never)})`;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({
        id: createId(),
        snapshot_id: id,
        model_id: r.modelId,
        configuration_key: storedConfigurationKey(r),
        configuration_label: r.configuration.label,
        configuration_kind: r.configuration.kind,
        configuration_priority: r.configuration.priority,
        selected_for_product: r.selected,
        selection_reason: r.selectionReason,
        metric_key: r.metricKey,
        metric_name: r.metricName,
        raw_score: r.rawScore,
        normalized_score: null,
        lower_bound: r.lowerBound ?? null,
        upper_bound: r.upperBound ?? null,
        source_rank: r.sourceRank ?? null,
        sample_size: r.sampleSize ?? null,
        source_model_name: r.sourceModelName,
        source_organization: r.organization ?? null,
        source_published_at: r.sourcePublishedAt ?? null,
        metadata: tx.json({ ...(r.metadata ?? {}), configurationKind: r.configuration.kind, configurationLabel: r.configuration.label } as never),
      }));
      await tx`INSERT INTO lb_scores ${tx(chunk as never)}`;
    }
  });
  return { snapshotId: id, changed: true, rows: rows.length, selected: selected.length, newModels: newModels.length };
}
