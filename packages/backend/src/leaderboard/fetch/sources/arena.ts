// LMArena human-preference boards (style-controlled text, creative writing, WebDev, vision) from the
// official Hugging Face dataset. Ratings carry their 95% bounds; tiers come from the model name.
import { configurationOf, peelTierSuffix, scaffolded, slug } from "../configuration.ts";
import { hfDatasetSha, hfParquetRows } from "../hf.ts";
import type { FetchResult, Fetcher, ParsedRow } from "../types.ts";

const DATASET = "lmarena-ai/leaderboard-dataset";

interface ArenaRow {
  model_name: string;
  organization: string | null;
  license: string | null;
  rating: number;
  rating_lower: number | null;
  rating_upper: number | null;
  variance?: number | null;
  vote_count: number | null;
  rank: number | null;
  category: string;
  leaderboard_publish_date: string | null;
}

const BOARDS: Array<{ key: string; name: string; config: string; category: string; license?: string; attributionUrl?: string }> = [
  { key: "arena-text", name: "Arena Text Style-Controlled", config: "text_style_control", category: "overall" },
  {
    key: "arena-creative-writing", name: "Arena Creative Writing", config: "text_style_control", category: "creative_writing",
    license: "CC BY 4.0 · Arena 官方 Hugging Face leaderboard-dataset；保留署名、来源链接并说明聚合改动。", attributionUrl: "https://arena.ai/leaderboard/text/creative-writing",
  },
  { key: "arena-webdev", name: "Arena WebDev", config: "webdev", category: "overall" },
  { key: "arena-vision", name: "Arena Vision Style-Controlled", config: "vision_style_control", category: "overall" },
];

export function arenaConfiguration(modelName: string) {
  const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(modelName.trim());
  let base = paren ? paren[1]!.trim() : modelName.trim();
  const descriptors = paren ? paren[2]!.split(/\s*,\s*/) : [];
  const systemNames = descriptors.filter((d) => /harness|agent|scaffold/i.test(d));
  const system = systemNames.map((d) => `name-${slug(d)}`);
  const runDescriptors = descriptors.filter((d) => !/harness|agent|scaffold/i.test(d));
  const peeled = peelTierSuffix(base);
  if (peeled.tier) {
    base = peeled.base;
    runDescriptors.push(peeled.tier);
  }
  const first = configurationOf(runDescriptors);
  return { base, configuration: system.length ? scaffolded(first, system, systemNames) : first };
}

export const arena: Fetcher = {
  sourceKeys: BOARDS.map((b) => b.key),
  async fetch() {
    const revision = await hfDatasetSha(DATASET);
    if (!revision) throw new Error("cannot read the dataset revision");
    const out: FetchResult[] = [];
    const files = new Map<string, ArenaRow[]>();
    for (const b of BOARDS) {
      if (!files.has(b.config)) files.set(b.config, await hfParquetRows<ArenaRow>(DATASET, revision, `${b.config}/latest-00000-of-00001.parquet`));
      const rows = files.get(b.config)!.filter((r) => r.category === b.category);
      const published = rows.map((r) => r.leaderboard_publish_date).filter(Boolean).sort().pop() ?? null;
      const parsed: ParsedRow[] = rows.map((r) => {
        const { base, configuration } = arenaConfiguration(r.model_name);
        return {
          sourceModelName: r.model_name,
          keyName: slug(r.model_name),
          baseName: base,
          organization: r.organization,
          configuration,
          metricKey: b.key,
          metricName: b.name,
          rawScore: r.rating,
          lowerBound: r.rating_lower,
          upperBound: r.rating_upper,
          sourceRank: r.rank,
          sampleSize: r.vote_count === null ? null : Math.round(r.vote_count),
          sourcePublishedAt: r.leaderboard_publish_date ? `${r.leaderboard_publish_date}T00:00:00.000Z` : null,
          metadata: { lowerBound: r.rating_lower, upperBound: r.rating_upper, variance: r.variance ?? null, arenaConfig: b.config, arenaCategory: b.category, sourceLicense: r.license, originalSourceRank: r.rank, metricDirection: "HIGHER" },
        };
      });
      out.push({
        sourceKey: b.key,
        sourceName: b.name,
        sourceUrl: `https://huggingface.co/datasets/${DATASET}`,
        license: b.license ?? "CC BY 4.0",
        attributionUrl: b.attributionUrl ?? `https://huggingface.co/datasets/${DATASET}`,
        publishedAt: published ? `${published}T00:00:00.000Z` : null,
        rows: parsed,
        metadata: { arenaConfig: b.config, arenaCategory: b.category, datasetRevision: revision, sourceOperator: "LMArena", sourceFamily: "arena-preference", metricCount: 1 },
      });
    }
    return out;
  },
};
