// TapTap Maker Benchmark: the latest edition's main board (L2 success rate with its interval).
// Contributor aliases are kept for reference but do not stand for a verified public model.
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { configurationOf, slug } from "../configuration.ts";
import type { Fetcher, ParsedRow } from "../types.ts";

const BASE = "https://maker.taptap.cn/leaderboard/data";
const CONTRIBUTOR = "来源的 contributor 别名未对应到已核实的公开模型。";

interface Row {
  rank: number;
  agent: string | null;
  model: string;
  provider: string | null;
  reasoning_effort: string | null;
  reasoning_mode: string | null;
  l2: { rate: number; ci95: [number, number] | null; ci_method: string | null };
  cost_per_case_usd: number | null;
}

export const taptap: Fetcher = {
  sourceKeys: ["taptap-maker"],
  async fetch() {
    const pointer = JSON.parse((await guardedFetch(`${BASE}/latest.json`, { timeoutMs: 30_000 })).text()) as { latest: string };
    const res = await guardedFetch(`${BASE}/editions/${encodeURIComponent(pointer.latest)}.json`, { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
    if (res.status !== 200) throw new Error(`taptap edition ${pointer.latest} HTTP ${res.status}`);
    const d = JSON.parse(res.text()) as { edition: { id: string; published_at: string; dataset_version: string; dataset_hash_prefix: string; engine_commits?: string[] }; main_board: Row[] };
    const rows: ParsedRow[] = d.main_board.map((r) => {
      const configuration = configurationOf(r.reasoning_effort ? [r.reasoning_effort] : []);
      if (/-contributor$/i.test(r.model.split("@")[0]!)) configuration.ineligible = CONTRIBUTOR;
      return {
        sourceModelName: r.model,
        keyName: slug(r.model),
        baseName: r.model.split("@")[0]!,
        organization: r.provider,
        configuration,
        metricKey: "taptap-maker",
        metricName: "TapTap Maker Benchmark",
        rawScore: r.l2.rate,
        lowerBound: r.l2.ci95?.[0] ?? null,
        upperBound: r.l2.ci95?.[1] ?? null,
        sourceRank: r.rank,
        metadata: { ciMethod: r.l2.ci_method, editionId: d.edition.id, agentDriver: r.agent, reasoningMode: r.reasoning_mode, reasoningEffort: r.reasoning_effort, costPerCaseUsd: r.cost_per_case_usd, metricDirection: "HIGHER" },
      };
    });
    return [{
      sourceKey: "taptap-maker",
      sourceName: "TapTap Maker Benchmark",
      sourceUrl: `${BASE}/latest.json`,
      license: "官方公开结果；公开再展示保留官方署名，完整再分发授权仍以易玩／TapTap 条款为准",
      attributionUrl: "https://maker.taptap.cn/leaderboard/",
      publishedAt: `${d.edition.published_at}T00:00:00.000Z`,
      rows,
      metadata: { editionId: d.edition.id, datasetVersion: d.edition.dataset_version, datasetHash: d.edition.dataset_hash_prefix, engineCommits: d.edition.engine_commits ?? null, officialBoard: "main_board_l2", upstreamPublishedAt: d.edition.published_at, comparisonSubject: "SYSTEM_CONFIGURATION", sourceOperator: "TapTap Maker", sourceFamily: "game-development", metricCount: 1 },
    }];
  },
};
