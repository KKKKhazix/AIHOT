// LiveBench (Apache 2.0): the latest release's per-task table; category scores are means of unrounded
// task scores, and each board averages its category pair (general: all categories).
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { configurationOf, peelEffortSuffix, slug } from "../configuration.ts";
import { parseCsv } from "../csv.ts";
import type { FetchResult, Fetcher, ParsedRow } from "../types.ts";

const BOARDS = [
  { key: "livebench-general", name: "LiveBench Global Average", categories: null as string[] | null, url: "https://livebench.ai/" },
  { key: "livebench-writing", name: "LiveBench · 语言与指令", categories: ["Language", "IF"], url: "https://livebench.ai/#/?cats=Language%2CIF&ft=1" },
  { key: "livebench-coding", name: "LiveBench · 编程综合", categories: ["Coding", "Agentic Coding"], url: "https://livebench.ai/#/?cats=Coding%2CAgentic+Coding&ft=1" },
  { key: "livebench-reasoning", name: "LiveBench · 推理与数学", categories: ["Reasoning", "Mathematics"], url: "https://livebench.ai/#/?cats=Reasoning%2CMathematics&ft=1" },
];

const mean =(xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The newest release date the site lists (its bundle carries the release array). */
async function latestRelease(): Promise<string> {
  const home = (await guardedFetch("https://livebench.ai/", { timeoutMs: 30_000 })).text();
  const js = /src="\.?\/?(static\/js\/main\.[a-z0-9]+\.js)"/.exec(home)?.[1];
  if (!js) throw new Error("livebench: bundle not found");
  const bundle = (await guardedFetch(`https://livebench.ai/${js}`, { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 })).text();
  const arrays = [...bundle.matchAll(/\[((?:"\d{4}-\d{2}-\d{2}",?){3,})\]/g)].map((m) => m[1]!.match(/\d{4}-\d{2}-\d{2}/g)!);
  const dates = arrays.sort((a, b) => b.length - a.length)[0];
  if (!dates?.length) throw new Error("livebench: release list not found");
  return [...dates].sort().pop()!;
}

export const livebench: Fetcher = {
  sourceKeys: BOARDS.map((b) => b.key),
  async fetch() {
    const release = await latestRelease();
    const tag = release.replaceAll("-", "_");
    const categories = JSON.parse((await guardedFetch(`https://livebench.ai/categories_${tag}.json`, { timeoutMs: 30_000 })).text()) as Record<string, string[]>;
    const table = await guardedFetch(`https://livebench.ai/table_${tag}.csv`, { timeoutMs: 30_000 });
    if (table.status !== 200) throw new Error(`livebench table ${release} HTTP ${table.status}`);
    const upstream = table.headers.get("last-modified");
    const lines = parseCsv(table.text());
    const modelColumn = Object.keys(lines[0] ?? {})[0];
    const out: FetchResult[] = [];
    for (const b of BOARDS) {
      const cats = b.categories ?? Object.keys(categories);
      const rows: ParsedRow[] = [];
      for (const line of lines) {
        const model = modelColumn ? line[modelColumn]?.trim() : null;
        if (!model) continue;
        const categoryScores: number[] = [];
        for (const c of cats) {
          const vals = (categories[c] ?? []).map((t) => line[t]?.trim()).filter((v) => v != null && v !== "").map(Number).filter(Number.isFinite);
          if (vals.length === (categories[c] ?? []).length && vals.length) categoryScores.push(mean(vals));
        }
        if (categoryScores.length !== cats.length) continue;
        const peeled = peelEffortSuffix(model);
        rows.push({
          sourceModelName: model,
          keyName: slug(model),
          baseName: peeled.base,
          configuration: configurationOf(peeled.tier ? [peeled.tier] : []),
          metricKey: b.key,
          metricName: b.name,
          rawScore: mean(categoryScores),
          // Each category's own score, shown beside the pair on a model's evidence.
          metadata: {
            release, categories: cats.join(" + "), categoryCount: cats.length, metricDirection: "HIGHER",
            ...Object.fromEntries(cats.map((c, i) => [`livebenchCategoryScore:${c}`, categoryScores[i]!])),
            livebenchTaskScores: Object.fromEntries(cats.flatMap((c) => (categories[c] ?? []).map((task) => [task, Number(line[task])]))),
          },
        });
      }
      out.push({
        sourceKey: b.key,
        sourceName: b.name,
        sourceUrl: "https://livebench.ai/",
        license: "Apache 2.0",
        attributionUrl: b.url,
        publishedAt: upstream ? new Date(upstream).toISOString() : null,
        rows,
        metadata: { release, taskGroups: Object.fromEntries(cats.map((c) => [c, categories[c]])), upstreamPublishedAt: upstream ? new Date(upstream).toISOString() : null, sourceOperator: "LiveBench", sourceFamily: "rolling-objective", metricCount: 1 },
      });
    }
    return out;
  },
};
