// EQ-Bench creative writing (v3, Elo) and long-form writing (score out of 100). The site embeds each
// leaderboard as CSV in a JS file; the site repository's head commit dates the data.
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { configurationOf } from "../configuration.ts";
import { headCommit } from "../github.ts";
import { parseCsv } from "../csv.ts";
import type { FetchResult, Fetcher, ParsedRow } from "../types.ts";

const BOARDS = [
  { key: "eq-creative", name: "Creative Writing v3", file: "creative_writing.js", column: "elo_score", version: "creative-writing-v3", page: "https://eqbench.com/creative_writing.html" },
  { key: "eq-longform", name: "Longform Writing", file: "creative_writing_longform.js", column: "overall_score_100", version: "longform-v1.11", page: "https://eqbench.com/creative_writing_longform.html" },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** First template literal holding a CSV that starts with model_name. */
function leaderboardCsv(js: string): Array<Record<string, string>> {
  const m = /`\s*(model_name,[^`]+)`/.exec(js);
  if (!m) throw new Error("eqbench: leaderboard CSV not found");
  return parseCsv(m[1]!);
}

export const eqbench: Fetcher = {
  sourceKeys: BOARDS.map((b) => b.key),
  async fetch() {
    const commit = await headCommit("EQ-bench/EQ-bench-site");
    const out: FetchResult[] = [];
    for (const b of BOARDS) {
      const res = await guardedFetch(`https://eqbench.com/${b.file}`, { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
      if (res.status !== 200) throw new Error(`eqbench ${b.file} HTTP ${res.status}`);
      const lines = leaderboardCsv(res.text());
      if (!lines[0] || !(b.column in lines[0])) throw new Error(`eqbench ${b.file}: column ${b.column} missing`);
      const rows: ParsedRow[] = [];
      for (const line of lines) {
        const name = line.model_name?.replace(/^\*/, "").trim();
        const value = line[b.column]?.trim();
        const score = Number(value);
        if (!name || !value || !Number.isFinite(score)) continue;
        rows.push({
          sourceModelName: name,
          keyName: slug(name),
          baseName: name.includes("/") ? name.split("/").pop()! : name,
          configuration: configurationOf([]),
          metricKey: b.key,
          metricName: b.name,
          rawScore: score,
          metadata: { benchmarkVersion: b.version, metricDirection: "HIGHER" },
        });
      }
      out.push({
        sourceKey: b.key,
        sourceName: b.name,
        sourceUrl: `https://eqbench.com/${b.file}`,
        license: "MIT · EQ-bench-site README 元数据声明",
        attributionUrl: b.page,
        publishedAt: commit.date,
        rows,
        metadata: { dataAtKind: "score-data-commit", dataCommit: commit.sha, upstreamPublishedAt: commit.date, benchmarkVersion: b.version, sourceOperator: "EQ-Bench", sourceFamily: "judged-creative-writing", metricCount: 1 },
      });
    }
    return out;
  },
};
