// DeepSWE v1.1 (DataCurve): every model through the same mini-swe-agent harness; pass@1 with a 95%
// run-to-run interval. The highest reasoning tier run represents the base model.
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { configurationOf, scaffolded, slug } from "../configuration.ts";
import { competitionRanks } from "../rank.ts";
import type { Fetcher, ParsedRow } from "../types.ts";

const URL_ = "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json";

interface Row {
  model: string;
  harness: string;
  provider: string | null;
  reasoning_effort: string | null;
  config: string;
  pass_rate: number;
  ci_lo: number | null;
  ci_hi: number | null;
  n_runs: number | null;
  n_attempted: number | null;
  n_tasks_attempted: number | null;
  ci_method: string | null;
  mean_cost_usd: number | null;
}

export const deepswe: Fetcher = {
  sourceKeys: ["deepswe-v1-1"],
  async fetch() {
    const res = await guardedFetch(URL_, { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
    if (res.status !== 200) throw new Error(`deepswe HTTP ${res.status}`);
    const d = JSON.parse(res.text()) as { generated_at: string; n_tasks_in_set: number; rows: Row[] };
    const rank = competitionRanks(d.rows.map((r) => r.pass_rate));
    const rows: ParsedRow[] = d.rows.map((r, i) => {
      const systemId = `deepswe-v1.1:${r.harness}`;
      const configuration = scaffolded(configurationOf(r.reasoning_effort ? [r.reasoning_effort] : []), [`harness-${slug(r.harness)}`, slug(r.config), `systemid-${slug(systemId)}`], [r.harness, systemId]);
      return {
        sourceModelName: r.model,
        baseName: r.model,
        organization: r.provider,
        configuration,
        metricKey: "deepswe-v1-1",
        metricName: "DeepSWE v1.1",
        rawScore: r.pass_rate,
        lowerBound: r.ci_lo,
        upperBound: r.ci_hi,
        sourceRank: rank[i],
        sampleSize: r.n_attempted,
        metadata: { benchmarkVersion: "1.1", harness: r.harness, harnessConfig: r.config, ciMethod: r.ci_method, runCount: r.n_runs, systemId, taskCount: r.n_tasks_attempted, meanCostUsd: r.mean_cost_usd, metricDirection: "HIGHER" },
      };
    });
    return [{
      sourceKey: "deepswe-v1-1",
      sourceName: "DeepSWE v1.1",
      sourceUrl: URL_,
      license: "官方公开结构化结果；仅管理员私有观察，公开前复核许可",
      attributionUrl: "https://deepswe.datacurve.ai/",
      publishedAt: d.generated_at,
      rows,
      metadata: { harness: "mini-swe-agent", comparisonSubject: "CONTROLLED_SYSTEM", upstreamTaskCount: d.n_tasks_in_set, upstreamPublishedAt: d.generated_at, sourceOperator: "DataCurve", sourceFamily: "software-engineering", metricCount: 1 },
    }];
  },
};
