// One leaderboard computation round: build inputs from the latest snapshots, compute every board
// with the current method, and publish only when the evidence changed and every published board solved
// to optimality. A failed round keeps the previous published run on the site.
import { LEADERBOARD_PUBLIC_BOARDS } from "@aihot/contracts/taxonomy";
import { newArticleId, sha256, stableJson } from "../../lib/ids.ts";
import { sql } from "../../db.ts";
import { buildRunInputs, type RunInputs } from "./inputs.ts";
import { ANCHORS, BUDGETS, METHOD_VERSION } from "./consensus.ts";
import { computeBoardsInWorker } from "./compute.ts";

export interface RoundResult {
  /** "refreshed": the same ranking republished with the current exchange rate and verification times. */
  status: "published" | "refreshed" | "unchanged" | "failed";
  runId: string | null;
  fingerprint: string;
  boards: Array<{ board: string; models: number; optimal: boolean; ms: number }>;
  reason?: string;
}

/** Everything that can change a ranking, and nothing that cannot (fetch times, verification stamps). */
export function inputFingerprint(inputs: RunInputs): string {
  return sha256(stableJson({ method: METHOD_VERSION, boards: inputs.boards }));
}

async function currentFxQuote() {
  const [fx] = await sql<{ as_of: Date; rate: number; source_name: string; source_url: string | null }[]>`
    SELECT as_of, rate, source_name, source_url FROM fx_rates WHERE pair = 'USD/CNY' ORDER BY as_of DESC LIMIT 1`;
  return fx ? { asOf: fx.as_of.toISOString().slice(0, 10), rate: fx.rate, sourceName: fx.source_name, sourceUrl: fx.source_url } : null;
}

/**
 * Evidence moved on without moving the ranking (a newer exchange rate, sources verified again): the
 * same ranking is published again as a new run carrying the current evidence, so prices and the
 * sources' verification times on the site stay current. Nothing is solved again. Returns the new run.
 */
async function republishEvidence(latestId: string, inputs: RunInputs, at: Date): Promise<string | null> {
  const [latest] = await sql<{ summary: Record<string, any> }[]>`SELECT summary FROM lb_runs WHERE id = ${latestId}`;
  if (!latest) return null;
  const fxQuote = await currentFxQuote();
  const was = latest.summary;
  const evidenceOf = (x: { fxQuote?: unknown; consensus?: { evidence?: unknown; exclusions?: unknown } }) =>
    stableJson({ fx: x.fxQuote ?? null, evidence: x.consensus?.evidence ?? null, exclusions: x.consensus?.exclusions ?? null });
  const next = { ...was, fxQuote, consensus: { ...was.consensus, evidence: inputs.evidence, exclusions: inputs.exclusions } };
  if (evidenceOf(next) === evidenceOf(was)) return null;
  const runId = newArticleId();
  await sql.begin(async (tx) => {
    const [run] = await tx<{ methodology_version: string }[]>`SELECT methodology_version FROM lb_runs WHERE id = ${latestId}`;
    await tx`INSERT INTO lb_runs (id, methodology_version, generated_at, source_snapshot_ids, summary, status, origin)
             VALUES (${runId}, ${run!.methodology_version}, ${at}, ${inputs.snapshotIds}, ${tx.json(next as never)}, 'published', 'computed')`;
    await tx`INSERT INTO lb_rankings (run_id, board, model_id, rank, score, coverage, detail)
             SELECT ${runId}, board, model_id, rank, score, coverage, detail FROM lb_rankings WHERE run_id = ${latestId}`;
  });
  return runId;
}

export async function runLeaderboardRound(opts: { force?: boolean } = {}): Promise<RoundResult> {
  const at = new Date();
  const inputs = await buildRunInputs({ at });
  const fingerprint = inputFingerprint(inputs);
  const [latest] = await sql<{ id: string; fingerprint: string | null }[]>`
    SELECT id, summary->'consensus'->>'fingerprint' AS fingerprint FROM lb_runs
    WHERE status = 'published' ORDER BY generated_at DESC LIMIT 1`;
  if (!opts.force && latest?.fingerprint === fingerprint) {
    const refreshed = await republishEvidence(latest.id, inputs, at);
    return { status: refreshed ? "refreshed" : "unchanged", runId: refreshed ?? latest.id, fingerprint, boards: [] };
  }

  const { outputs, timings } = await computeBoardsInWorker(inputs.boards);

  // A published board must solve to optimality over one connected evidence network, and meet the
  // method's evidence minimums: the overall board at least 10 qualified models with 8 reference models
  // among them, a category 5 and 4. A board short of them fails the round, so the previous valid run
  // stays on the site.
  const enough = (board: string) => {
    const models = inputs.boards.find((b) => b.board === board)?.models ?? [];
    const anchors = models.filter((m) => (ANCHORS as readonly string[]).includes(m)).length;
    return board === "overall" ? models.length >= 10 && anchors >= 8 : models.length >= 5 && anchors >= 4;
  };
  const broken = LEADERBOARD_PUBLIC_BOARDS.filter((board) => {
    const output = outputs.find((o) => o.board === board);
    return !output || !output.solver.optimal || !output.scoring.optimal || !output.publishable_connectivity || !enough(board);
  });
  const reason = broken.length ? `not publishable: ${broken.join(", ")}` : undefined;

  const runId = newArticleId();
  const summary = {
    budgets: BUDGETS,
    fxQuote: await currentFxQuote(),
    sources: inputs.sources,
    consensus: {
      input: inputs.boards,
      boards: outputs,
      version: METHOD_VERSION,
      evidence: inputs.evidence,
      exclusions: inputs.exclusions,
      fingerprint,
      calculatedAt: new Date().toISOString(),
    },
    timings,
  };
  const status = reason ? "failed" : "published";
  await sql.begin(async (tx) => {
    await tx`INSERT INTO lb_runs (id, methodology_version, generated_at, source_snapshot_ids, summary, status, origin)
             VALUES (${runId}, ${METHOD_VERSION}, ${at}, ${inputs.snapshotIds}, ${tx.json(summary as never)}, ${status}, 'computed')`;
    if (status !== "published") return;
    const ids = new Map((await tx<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models WHERE slug = ANY(${outputs.flatMap((o) => o.entries.map((e) => e.slug))})`).map((r) => [r.slug, r.id]));
    for (const out of outputs) {
      const rows = out.entries
        .filter((e) => ids.has(e.slug))
        .map((e) => ({
          run_id: runId,
          board: out.board,
          model_id: ids.get(e.slug)!,
          rank: e.rank,
          score: e.score,
          coverage: e.coverage,
          detail: { scoreVersion: out.scoring.version, sourceCount: e.source_count, operatorCount: e.operator_count, unknownErrorCount: e.unknownErrorCount },
        }));
      for (let i = 0; i < rows.length; i += 500) await tx`INSERT INTO lb_rankings ${tx(rows.slice(i, i + 500) as never)}`;
    }
  });
  return { status, runId, fingerprint, boards: timings, reason };
}
