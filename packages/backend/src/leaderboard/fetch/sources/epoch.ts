// Epoch AI Benchmarking Hub (CC BY 4.0): Epoch's own evaluations, one CSV per benchmark in the
// published archive. The run setting follows the last underscore ("_xhigh", "_none", "_32K").
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { configurationOf, REASONS, slug } from "../configuration.ts";
import { parseCsv } from "../csv.ts";
import { unzipEntries } from "../unzip.ts";
import type { FetchResult, Fetcher, ParsedRow } from "../types.ts";

const ARCHIVE = "https://epoch.ai/data/benchmark_data.zip";

const BOARDS = [
  { key: "epoch-frontiermath", name: "FrontierMath v2 · Tiers 1–3", file: "frontiermath_tiers_1_3_v2.csv", page: "https://epoch.ai/benchmarks/frontiermath-tiers-1-3-v2" },
  { key: "epoch-frontiermath-tier4", name: "FrontierMath v2 · Tier 4", file: "frontiermath_tier_4_v2.csv", page: "https://epoch.ai/benchmarks/frontiermath-tier-4-v2" },
  { key: "epoch-chess", name: "Chess Puzzles", file: "chess_puzzles.csv", page: "https://epoch.ai/benchmarks/chess-puzzles" },
  { key: "epoch-mystery", name: "Mystery Game Puzzles", file: "mystery_game_puzzles.csv", page: "https://epoch.ai/benchmarks/mystery-game-puzzles" },
  { key: "epoch-simpleqa", name: "SimpleQA Verified", file: "simpleqa_verified.csv", page: "https://epoch.ai/benchmarks/simple-qa-verified" },
  { key: "epoch-gpqa", name: "GPQA Diamond", file: "gpqa_diamond.csv", page: "https://epoch.ai/benchmarks/gpqa-diamond" },
  { key: "epoch-mirrorcode", name: "MirrorCode", file: "mirrorcode.csv", page: "https://epoch.ai/benchmarks/mirrorcode" },
  { key: "epoch-ebr", name: "EBR-bench", file: "ebr_bench.csv", page: "https://epoch.ai/benchmarks/ebr-bench" },
];

/** Agent systems and unverified run settings that cannot stand for one public model. */
const SPECIAL_SYSTEMS = new Set(["gdm-ai-co-mathematician"]);
const TIER = /^(xhigh|high|medium|low|max|minimal)$/i;

export function epochConfiguration(version: string) {
  const i = version.lastIndexOf("_");
  const suffix = i > 0 ? version.slice(i + 1) : "";
  const base = i > 0 ? version.slice(0, i) : version;
  let configuration;
  let name = base;
  if (TIER.test(suffix)) configuration = configurationOf([suffix.toLowerCase()]);
  else if (/^none$/i.test(suffix)) configuration = configurationOf(["non-reasoning"]);
  else if (/^\d+k$/i.test(suffix)) configuration = configurationOf([`thinking-${suffix.toLowerCase()}`]);
  else if (/^promax$/i.test(suffix)) {
    configuration = { ...configurationOf([]), ineligible: REASONS.special };
  } else {
    name = version; // "_8B"-style suffixes belong to the model name
    configuration = configurationOf([]);
  }
  if (/pre-release/i.test(version)) configuration = { ...configuration, ineligible: REASONS.preRelease };
  if (SPECIAL_SYSTEMS.has(version)) configuration = { ...configuration, ineligible: REASONS.special };
  return { base: name, configuration };
}

export const epoch: Fetcher = {
  sourceKeys: BOARDS.map((b) => b.key),
  async fetch() {
    const res = await guardedFetch(ARCHIVE, { timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024 });
    if (res.status !== 200) throw new Error(`epoch archive HTTP ${res.status}`);
    const entries = unzipEntries(res.body);
    const out: FetchResult[] = [];
    for (const b of BOARDS) {
      const read = entries.get(b.file);
      if (!read) throw new Error(`epoch archive lacks ${b.file}`);
      const records = parseCsv(read().toString("utf8"));
      let latest: string | null = null;
      const rows: ParsedRow[] = [];
      for (const r of records) {
        const version = (r["Model version"] ?? "").trim();
        const score = Number(r.mean_score);
        const started = r["Started at"] || null;
        // Only Epoch's own runs (they carry a start time); reported third-party numbers are left out.
        if (!version || r.mean_score === "" || !Number.isFinite(score) || !started) continue;
        if (started && (!latest || started > latest)) latest = started;
        const { base, configuration } = epochConfiguration(version);
        // The interval shown is the score ± Epoch's standard error, when it reports one.
        const stderr = r.stderr === "" ? NaN : Number(r.stderr);
        const hasError = Number.isFinite(stderr);
        rows.push({
          sourceModelName: version,
          keyName: slug(version),
          baseName: base,
          organization: r.Organization || null,
          releasedAt: r["Release date"] || null,
          configuration,
          metricKey: b.key,
          metricName: b.name,
          rawScore: score,
          lowerBound: hasError ? score - stderr : null,
          upperBound: hasError ? score + stderr : null,
          sourcePublishedAt: started,
          metadata: {
            stderr: Number.isFinite(stderr) ? stderr : null, runId: r.id || null, measuredAt: started,
            logUrl: r["Log viewer"] || r.Logs || null, metricDirection: "HIGHER",
          },
        });
      }
      out.push({
        sourceKey: b.key,
        sourceName: b.name,
        sourceUrl: ARCHIVE,
        license: "CC BY 4.0 · Epoch AI 自行评测数据",
        attributionUrl: b.page,
        publishedAt: latest,
        rows,
        metadata: { dataAtKind: "latest-evaluation", benchmarkFile: b.file, scoringField: "mean_score", upstreamPublishedAt: latest, attribution: "Epoch AI · AI Benchmarking Hub · CC BY 4.0", sourceOperator: "Epoch AI", metricCount: 1 },
      });
    }
    return out;
  },
};
