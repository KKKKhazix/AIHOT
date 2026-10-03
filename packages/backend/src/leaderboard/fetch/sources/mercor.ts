// Mercor APEX-Agents: every model runs through Mercor's own agent harness, so rows are controlled-system
// results (pass@1 ± the reported error, per model and reasoning effort). The leaderboard page carries the
// whole board in its Next.js data; the edition date is the publish date of the post it links to.
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { configurationOf, scaffolded, slug } from "../configuration.ts";
import { competitionRanks } from "../rank.ts";
import type { Fetcher, ParsedRow } from "../types.ts";

const PAGE = "https://www.mercor.com/apex/apex-agents-leaderboard/";
const HARNESS = "loop_truncated_tools_agent";

interface Entry {
  model: { modelId: string; modelName: string; effort: string | null; releaseDate: string | null; provider: { name: string } | null };
  nSamples: number | null;
  passScores: Array<{ pass: string; score: number; error: number | null; harnessScores?: Array<{ harness: string; score: number; error: number | null }> }>;
}

interface Benchmark {
  benchmarkId: string;
  displayName: string;
  blogLink: string | null;
  dataLink: string | null;
  availableHarnesses: unknown[];
  globalLeaderboard: Entry[];
}

async function page(url: string): Promise<string> {
  const res = await guardedFetch(url, { timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  if (res.status !== 200) throw new Error(`mercor ${url} HTTP ${res.status}`);
  return res.text();
}

export const mercor: Fetcher = {
  sourceKeys: ["mercor-apex-agents"],
  async fetch() {
    const html = await page(PAGE);
    const next = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!next) throw new Error("mercor: page data not found");
    const b = (JSON.parse(next[1]!) as { props: { pageProps: { benchmark: Benchmark } } }).props.pageProps.benchmark;
    const version = /-v(\d+(?:\.\d+)*)\/?$/.exec(b.dataLink ?? "")?.[1];
    if (!version) throw new Error(`mercor: no benchmark version in ${b.dataLink}`);
    const systemId = `${b.benchmarkId}:v${version}:${HARNESS}`;

    const scored = b.globalLeaderboard.flatMap((e) => {
      const pass1 = e.passScores.find((p) => p.pass === "pass-1")?.harnessScores?.find((h) => h.harness === HARNESS);
      return pass1 ? [{ e, score: pass1.score, error: pass1.error }] : [];
    });
    if (scored.length < b.globalLeaderboard.length / 2) throw new Error(`mercor: only ${scored.length}/${b.globalLeaderboard.length} rows have ${HARNESS} pass@1`);

    let publishedAt: string | null = null;
    if (b.blogLink) {
      const post = await page(b.blogLink);
      const date = /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(post)?.[1];
      if (date) publishedAt = `${date}T00:00:00.000Z`;
    }

    const rank = competitionRanks(scored.map((s) => s.score));
    const rows: ParsedRow[] = scored.map(({ e, score, error }, i) => {
      const m = e.model;
      const effort = m.effort?.toLowerCase() ?? null;
      const configuration = scaffolded(configurationOf(effort ? [effort] : []), [`harness-${slug(HARNESS)}`, `systemid-${slug(systemId)}`], [HARNESS, systemId]);
      return {
        sourceModelName: m.modelId,
        keyName: slug(m.modelId),
        baseName: effort && m.modelId.toLowerCase().endsWith(`-${effort}`) ? m.modelId.slice(0, -effort.length - 1) : m.modelId,
        organization: m.provider?.name ?? null,
        releasedAt: m.releaseDate,
        configuration,
        metricKey: "mercor-apex-agents:loop-pass-1",
        metricName: `${b.displayName} ${version} Pass@1 · Loop`,
        rawScore: score,
        lowerBound: error == null ? null : score - error,
        upperBound: error == null ? null : score + error,
        sourceRank: rank[i],
        sampleSize: e.nSamples,
        sourcePublishedAt: publishedAt,
        metadata: { benchmarkVersion: version, sourceModelId: m.modelId, harness: HARNESS, systemId, statistic: "pass-1", reasoningEffort: m.effort, reportedError: error, metricDirection: "HIGHER" },
      };
    });

    return [{
      sourceKey: "mercor-apex-agents",
      sourceName: `Mercor ${b.displayName} ${version}`,
      sourceUrl: PAGE,
      license: "官方公开结果；数据与代码许可不等于榜单再分发授权",
      attributionUrl: PAGE,
      publishedAt,
      rows,
      metadata: {
        harnesses: HARNESS,
        statistic: "pass-1",
        dataAtKind: "benchmark-edition-publication",
        datasetUrl: b.dataLink,
        dataDateSource: b.blogLink,
        benchmarkVersion: version,
        comparisonSubject: "CONTROLLED_SYSTEM",
        upstreamPublishedAt: publishedAt,
        sourceOperator: "Mercor",
        sourceFamily: "professional-work",
        metricCount: 1,
      },
    }];
  },
};
