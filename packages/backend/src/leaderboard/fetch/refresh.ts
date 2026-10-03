// The four-times-a-day leaderboard refresh: fetch every upstream source (each on its own, retried once —
// a failing source keeps its last snapshot, which the method carries forward), store the snapshots whose
// content changed, fill missing context windows, update the USD/CNY rate used for prices and fill in the
// official prices of models that have none yet (database/seeds), then run the method round, which
// publishes only when the evidence changed.
import { sql } from "../../db.ts";
import { guardedFetch } from "../../lib/http-fetch.ts";
import { runLeaderboardRound, type RoundResult } from "../method/run.ts";
import { importOfficialPrices } from "../prices.ts";
import { modelSlug } from "./identity.ts";
import { FETCHERS } from "./index.ts";
import { storeSnapshot } from "./store.ts";
import type { FetchResult, Fetcher } from "./types.ts";

export interface SourceState {
  ok: boolean;
  at: string;
  lastOkAt: string | null;
  changed?: boolean;
  rows?: number;
  newModels?: number;
  error?: string;
}

const STATE_KEY = "leaderboard.fetch";

/** A parse that suddenly yields under half the rows of the last snapshot is treated as broken, not as news. */
async function plausible(r: FetchResult): Promise<string | null> {
  if (!r.rows.length) return "no rows parsed";
  const [prev] = await sql<{ n: number | null }[]>`
    SELECT (metadata->>'rawRowCount')::int AS n FROM lb_snapshots WHERE source_key = ${r.sourceKey} ORDER BY fetched_at DESC LIMIT 1`;
  if (prev?.n && r.rows.length < prev.n / 2) return `only ${r.rows.length} rows (last snapshot had ${prev.n})`;
  return null;
}

/** One more try after a pause: a single upstream hiccup (a stray 401 or timeout) should not leave a source six hours stale. */
async function fetchWithRetry(f: Fetcher, delayMs: number): Promise<FetchResult[]> {
  try {
    return await f.fetch();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return f.fetch();
  }
}

export async function fetchSources(opts: { retryDelayMs?: number } = {}): Promise<Record<string, SourceState>> {
  const [saved] = await sql<{ value: { sources?: Record<string, SourceState> } }[]>`SELECT value FROM settings WHERE key = ${STATE_KEY}`;
  const states: Record<string, SourceState> = { ...(saved?.value.sources ?? {}) };
  const fail = (key: string, error: string) => {
    states[key] = { ok: false, at: new Date().toISOString(), lastOkAt: states[key]?.lastOkAt ?? null, error: error.slice(0, 300) };
  };
  // Overlap two independent upstream waits. Store in registry order: model identity resolution can
  // depend on a previous source's aliases, so concurrent fetching must not reorder snapshot writes.
  for (let start = 0; start < FETCHERS.length; start += 2) {
    const batch = FETCHERS.slice(start, start + 2);
    const fetched = await Promise.allSettled(batch.map((f) => fetchWithRetry(f, opts.retryDelayMs ?? 15_000)));
    for (const [i, outcome] of fetched.entries()) {
      const f = batch[i]!;
      if (outcome.status === "rejected") {
        for (const k of f.sourceKeys) fail(k, (outcome.reason as Error).message);
        continue;
      }
      const results = outcome.value;
      for (const k of f.sourceKeys) if (!results.some((r) => r.sourceKey === k)) fail(k, "source missing from the fetch result");
      for (const r of results) {
        try {
          const problem = await plausible(r);
          if (problem) throw new Error(problem);
          const s = await storeSnapshot(r);
          const at = new Date().toISOString();
          states[r.sourceKey] = { ok: true, at, lastOkAt: at, changed: s.changed, rows: s.rows, newModels: s.newModels };
        } catch (e) {
          fail(r.sourceKey, (e as Error).message);
        }
      }
    }
  }
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${STATE_KEY}, ${sql.json({ at: new Date().toISOString(), sources: states } as never)}, 'worker')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return states;
}

/** European Central Bank reference rate via Frankfurter (the rate and date the price column cites). */
export async function refreshFx(): Promise<{ asOf: string; rate: number }> {
  const url = "https://api.frankfurter.app/latest?from=USD&to=CNY";
  const res = await guardedFetch(url, { timeoutMs: 20_000 });
  if (res.status !== 200) throw new Error(`frankfurter HTTP ${res.status}`);
  const d = JSON.parse(res.text()) as { date: string; rates: { CNY?: number } };
  const rate = d.rates.CNY;
  if (!rate || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error("frankfurter: unexpected response");
  await sql`INSERT INTO fx_rates (as_of, pair, rate, source_name, source_url) VALUES (${d.date}, 'USD/CNY', ${rate}, '欧洲央行', ${url}) ON CONFLICT DO NOTHING`;
  return { asOf: d.date, rate };
}

/**
 * Context windows for models that have none (a model a source introduces arrives without one), from
 * OpenRouter's public catalog. Only empty values are filled; names are matched by slug, and a dated
 * snapshot ("…-2025-08-07") falls back to its undated name.
 */
export async function fillContextWindows(): Promise<{ filled: number }> {
  const missing = await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models WHERE context_window_tokens IS NULL`;
  if (!missing.length) return { filled: 0 };
  const res = await guardedFetch("https://openrouter.ai/api/v1/models", { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
  if (res.status !== 200) throw new Error(`openrouter HTTP ${res.status}`);
  const catalog = new Map<string, number>();
  for (const m of (JSON.parse(res.text()) as { data?: Array<{ id?: string; name?: string; context_length?: number }> }).data ?? []) {
    // Routing variants (":free", "~latest", "(batch)") are not separate models.
    if (!m.id || !m.name || m.id.startsWith("~") || m.id.includes(":") || /\((?:batch|fast|free|online)\)\s*$/i.test(m.name)) continue;
    const context = Number(m.context_length);
    if (!Number.isInteger(context) || context <= 0) continue;
    const slug = modelSlug(m.name.replace(/^[^:]{1,40}:\s*/, ""));
    if (slug && !catalog.has(slug)) catalog.set(slug, context);
  }
  let filled = 0;
  for (const m of missing) {
    const context = catalog.get(m.slug) ?? catalog.get(m.slug.replace(/-20\d{2}-?\d{2}-?\d{2}$/, ""));
    if (!context) continue;
    await sql`UPDATE lb_models SET context_window_tokens = ${context}, metadata_source = 'OpenRouter', metadata_updated_at = now(), updated_at = now()
              WHERE id = ${m.id} AND context_window_tokens IS NULL`;
    filled += 1;
  }
  return { filled };
}

export async function refreshLeaderboard(): Promise<{ sources: { ok: number; changed: string[]; failed: Array<{ key: string; error?: string }> }; context: unknown; fx: unknown; prices: unknown; round: Pick<RoundResult, "status" | "runId" | "reason"> }> {
  const states = await fetchSources();
  const context = await fillContextWindows().catch((e: Error) => ({ error: e.message }));
  const fx = await refreshFx().catch((e: Error) => ({ error: e.message }));
  const prices = await importOfficialPrices().then(({ written }) => ({ written }), (e: Error) => ({ error: e.message }));
  const round = await runLeaderboardRound();
  const entries = Object.entries(states);
  return {
    sources: {
      ok: entries.filter(([, s]) => s.ok).length,
      changed: entries.filter(([, s]) => s.ok && s.changed).map(([k]) => k),
      failed: entries.filter(([, s]) => !s.ok).map(([key, s]) => ({ key, error: s.error })),
    },
    context,
    fx,
    prices,
    round: { status: round.status, runId: round.runId, reason: round.reason },
  };
}
