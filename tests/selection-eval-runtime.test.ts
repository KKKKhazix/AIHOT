import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";
import { tierThreshold } from "@aihot/backend/editorial/analyze";

const exec = promisify(execFile);

// Scores sit at the industry's T1 threshold: T1 selects, T2 only when its threshold is no higher
// (76 against 60 in the AI example), a tier without a threshold never.
const T1 = tierThreshold("T1")!;
const T2_DECISION: "select" | "reject" = tierThreshold("T2")! <= T1 ? "select" : "reject";

interface GoldRow {
  caseId: string;
  material: { title: string; originalTitle: null; publishedAt: string; sourceName: string; bodyZh: null; bodyOriginal: string };
  sourceFacts: { sourceKind: "rss"; sourceTier: string; firstParty: boolean; language: "en" };
  samplingContext?: { benchmarkSplit?: string; samplingStratum?: string };
  gold: { decision: "select" | "reject" };
}

const row = (caseId: string, marker: string, tier: string, decision: "select" | "reject", split?: string): GoldRow => ({
  caseId,
  material: {
    title: `${marker} model release`,
    originalTitle: null,
    publishedAt: "2026-09-30T09:00:00+08:00",
    sourceName: `Source ${caseId}`,
    bodyZh: null,
    bodyOriginal: `${marker} released a model with benchmark, pricing and availability details. `.repeat(8),
  },
  sourceFacts: { sourceKind: "rss", sourceTier: tier, firstParty: tier === "T1", language: "en" },
  ...(split ? { samplingContext: { benchmarkSplit: split, samplingStratum: tier } } : {}),
  gold: { decision },
});

interface Result {
  meta: { split: string; promptVersion: string };
  model: string;
  reportPath: string;
  summary: { decisive: number; errors: number; accuracy: number; tokensIn: number; tokensOut: number };
  cases: Array<{ caseId: string; decision: string | null; error: string | null }>;
}

async function evaluate(rows: GoldRow[], providers: { prefilter: string; score: string }, opts: { split?: string } = {}): Promise<Result> {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-eval-"));
  let reportPath: string | undefined;
  try {
    const gold = path.join(dir, "gold.jsonl");
    writeFileSync(gold, rows.map((item) => JSON.stringify(item)).join("\n"));
    const args = ["scripts/eval-selection.ts", "--gold", gold, "--concurrency", "6", "--no-import"];
    if (opts.split) args.push("--split", opts.split);
    const { stdout } = await exec(process.execPath, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MODEL_CALLS_ENABLED: "true",
        SCORE_MODEL: "glm-5.3-flash-selection",
        PREFILTER_MODEL: "qwen3.7-flash",
        DASHSCOPE_BASE_URL: `${providers.prefilter}/v1`,
        DASHSCOPE_API_KEY: "test-key",
        ZHIPU_BASE_URL: `${providers.score}/v1`,
        ZHIPU_API_KEY: "test-key",
      },
      timeout: 20_000,
    });
    reportPath = stdout.split("\n").find((line) => line.startsWith("report: "))?.slice(8);
    assert.ok(reportPath, stdout);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      meta: { split: string; promptVersion: string };
      models: Record<string, { summary: Result["summary"]; cases: Result["cases"] }>;
    };
    const model = Object.keys(report.models)[0]!;
    return { meta: report.meta, model, reportPath, summary: report.models[model]!.summary, cases: report.models[model]!.cases };
  } finally {
    if (reportPath) rmSync(reportPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withoutModelOverrides<T>(run: () => Promise<T>): Promise<T> {
  const saved = await sql<{ key: string; value: unknown; updated_by: string | null; updated_at: Date }[]>`
    SELECT key, value, updated_by, updated_at FROM settings WHERE key IN ('models.score', 'models.prefilter')`;
  await sql`DELETE FROM settings WHERE key IN ('models.score', 'models.prefilter')`;
  try {
    return await run();
  } finally {
    await sql`DELETE FROM settings WHERE key IN ('models.score', 'models.prefilter')`;
    for (const row of saved) {
      await sql`
        INSERT INTO settings (key, value, updated_by, updated_at)
        VALUES (${row.key}, ${sql.json(row.value as never)}, ${row.updated_by}, ${row.updated_at})`;
    }
  }
}

after(async () => {
  await closeDb();
});

test("default evaluation follows the production score route and shares duplicate score inputs without changing tier decisions", async (t) => {
  await withoutModelOverrides(async () => {
    const prefilter = await stub(() => ({
      choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "relevant" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const score = await stub(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        choices: [{ message: { content: JSON.stringify({ attentionScore: T1 }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
    });
    t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });

    const marker = tag();
    const rows = [row(`${marker}-t1`, marker, "T1", "select"), row(`${marker}-t2`, marker, "T2", T2_DECISION), row(`${marker}-mp`, marker, "EXCLUDE_MP", "reject")];
    const cold = await evaluate(rows, { prefilter: prefilter.url, score: score.url });
    const warm = await evaluate(rows, { prefilter: prefilter.url, score: score.url });

    assert.equal(cold.model, "glm-5.3-flash-selection", "no --models follows SCORE_MODEL / production routing");
    assert.deepEqual(cold.summary, warm.summary, "cold and cached evaluations keep the same coverage and metrics");
    assert.deepEqual(Object.fromEntries(cold.cases.map((item) => [item.caseId.slice(marker.length + 1), item.decision])), { t1: "select", t2: T2_DECISION, mp: "reject" },
      "the shared score still uses each tier's threshold (cases come in the eval's seeded sample order)");
    assert.deepEqual([cold.summary.decisive, cold.summary.errors, cold.summary.accuracy], [3, 0, 1]);
    assert.deepEqual([prefilter.hits(), score.hits()], [3, 2], "three per-case prefilters, two shared score calls across both runs");
    assert.deepEqual([cold.summary.tokensIn, cold.summary.tokensOut], [230, 55], "shared score receipts count once");
  });
});

test("a shared unusable score fails every matching case once, then retry usage includes every provider attempt", async (t) => {
  await withoutModelOverrides(async () => {
    const prefilter = await stub(() => ({
      choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "relevant" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const score = await stub((hit) => ({
      choices: [{ message: { content: hit === 1 ? "not JSON" : JSON.stringify({ attentionScore: T1 }) } }],
      usage: { prompt_tokens: hit === 1 ? 100 : 300, completion_tokens: 20 },
    }));
    t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });

    const marker = tag();
    const rows = [row(`${marker}-t1`, marker, "T1", "select"), row(`${marker}-t2`, marker, "T2", T2_DECISION)];
    const failed = await evaluate(rows, { prefilter: prefilter.url, score: score.url });
    assert.deepEqual([failed.summary.decisive, failed.summary.errors], [0, 2]);
    assert.equal(score.hits(), 1, "matching cases share the failed score result within one run");
    assert.equal(failed.summary.tokensIn, 120, "both prefilters plus the unusable paid score are accounted");

    const retried = await evaluate(rows, { prefilter: prefilter.url, score: score.url });
    assert.deepEqual([retried.summary.decisive, retried.summary.errors, retried.summary.accuracy], [2, 0, 1]);
    assert.equal(score.hits(), 3, "the next run retries once, then performs score-2 once");
    assert.deepEqual([retried.summary.tokensIn, retried.summary.tokensOut], [720, 70], "usage includes the unusable attempt and both successful retries");
  });
});

test("custom split names cannot escape the evaluation output directory", async (t) => {
  await withoutModelOverrides(async () => {
    const prefilter = await stub(() => ({
      choices: [{ message: { content: JSON.stringify({ label: "BLOCK", reason: "irrelevant" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const score = await stub(() => {
      throw new Error("score should not run for blocked input");
    });
    t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });

    const marker = tag();
    const split = "../../../../outside";
    const result = await evaluate([row(`${marker}-blocked`, marker, "T1", "reject", split)], { prefilter: prefilter.url, score: score.url }, { split });
    assert.equal(path.dirname(result.reportPath), path.join(REPO_ROOT, ".data/eval"));
    assert.ok(path.basename(result.reportPath).startsWith("selection-outside-1-"));
    assert.equal(result.meta.split, split, "metadata keeps the original user-supplied split");
    assert.equal(score.hits(), 0);
  });
});
