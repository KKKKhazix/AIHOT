// Vals AI Finance Agent (v2): the benchmark page names the JSON file its results load from in an Astro
// island's props (each value serialised as [type, value]); the overall task gives each model's accuracy
// with its standard error. The run setting is the reported reasoning (or compute) effort; bare numbers are
// run settings here.
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { configurationOf, slug } from "../configuration.ts";
import type { Fetcher, ParsedRow } from "../types.ts";

const PAGE = "https://www.vals.ai/benchmarks/fabv2";

interface Result {
  accuracy: number | null;
  stderr: number | null;
  latency: number | null;
  cost_per_test: number | null;
  reasoning_effort: string | number | null;
  compute_effort: string | number | null;
  provider: string | null;
  harness: string | null;
}

interface View {
  metadata: { benchmark_id: string; version: string; updated: string | null; total_models: number | null; models: string[] };
  tasks: { overall: Record<string, Result> };
}

function unescapeAttribute(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" } as Record<string, string>)[e.toLowerCase()]!;
  });
}

/** Astro's serialised props: [0, value] (objects recurse), [1, array], [3, date], [11, ±Infinity]. */
function revive(v: unknown): unknown {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number") return v;
  const [type, value] = v as [number, unknown];
  if (type === 0 && value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, revive(x)]));
  if (type === 1) return (value as unknown[]).map(revive);
  if (type === 11) return value === 1 ? Infinity : -Infinity;
  return value;
}

/** The results file the benchmark page loads; its name changes with every build of the site. */
export function benchmarkViewUrl(html: string): string {
  for (const m of html.matchAll(/<astro-island\b([^>]*)>/g)) {
    const props = /\sprops="([^"]*)"/.exec(m[1]!);
    if (!props) continue;
    const url = revive((JSON.parse(unescapeAttribute(props[1]!)) as { benchmarkViewUrl?: unknown }).benchmarkViewUrl);
    if (typeof url === "string") return new URL(url, PAGE).toString();
  }
  throw new Error("vals: benchmark data not found on the page");
}

export const vals: Fetcher = {
  sourceKeys: ["vals-finance-agent"],
  async fetch() {
    const page = await guardedFetch(PAGE, { timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 });
    if (page.status !== 200) throw new Error(`vals HTTP ${page.status}`);
    const res = await guardedFetch(benchmarkViewUrl(page.text()), { timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 });
    if (res.status !== 200) throw new Error(`vals data HTTP ${res.status}`);
    const view = JSON.parse(res.text()) as View;
    const overall = view.tasks.overall;
    const published = view.metadata.updated;
    const publishedAt = published ? `${published}T00:00:00.000Z` : null;
    const rows: ParsedRow[] = [];
    for (const [name, r] of Object.entries(overall)) {
      if (r.accuracy == null || !Number.isFinite(r.accuracy)) continue;
      const effort = r.reasoning_effort ?? r.compute_effort;
      const configuration = configurationOf(effort == null ? [] : [String(effort)], { numericTokens: true });
      const model = name.split("/").pop()!;
      rows.push({
        sourceModelName: name,
        keyName: slug(name),
        baseName: model.replace(/[-_](thinking|reasoning)$/i, "").replace(/_/g, "-"),
        organization: r.provider,
        configuration,
        metricKey: "vals-finance-agent",
        metricName: "Vals Finance Agent",
        rawScore: r.accuracy,
        lowerBound: r.stderr == null ? null : r.accuracy - r.stderr,
        upperBound: r.stderr == null ? null : r.accuracy + r.stderr,
        sourcePublishedAt: publishedAt,
        metadata: {
          benchmarkVersion: view.metadata.version,
          sourceModelId: name,
          unit: "percent",
          harness: r.harness,
          standardError: r.stderr,
          standardErrorUnit: "percentage-points",
          standardErrorDefinition: "reported-standard-error-of-mean",
          costPerTestUsd: r.cost_per_test,
          latencySeconds: r.latency,
          reasoningEffort: effort,
          metricDirection: "HIGHER",
        },
      });
    }
    return [{
      sourceKey: "vals-finance-agent",
      sourceName: "Vals Finance Agent",
      sourceUrl: PAGE,
      license: "官方公开结果；公开再展示保留官方署名，完整再分发授权仍以 Vals 条款为准",
      attributionUrl: PAGE,
      publishedAt,
      rows,
      metadata: {
        valsTask: slug(view.metadata.benchmark_id),
        benchmarkVersion: view.metadata.version,
        upstreamPublishedAt: published,
        upstreamModelCount: view.metadata.total_models,
        sourceOperator: "Vals AI",
        sourceFamily: "professional-work",
        metricCount: 1,
      },
    }];
  },
};
