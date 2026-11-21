import type { Db } from "@aihot/backend/db";
import type { Period, TrendingRow } from "./parse.ts";

export async function saveSnapshot(db: Db, period: Period, rows: TrendingRow[], capturedAt: Date = new Date()): Promise<void> {
  if (rows.length === 0) return;
  const values = rows.map((r) => ({
    period, captured_at: capturedAt, rank: r.rank, repo: r.repo, description: r.description,
    language: r.language, stars: r.stars, stars_period: r.starsPeriod, url: r.url,
  }));
  // One statement, so a failing row leaves no half-written snapshot behind.
  await db`INSERT INTO github_trending_snapshots ${db(values, "period", "captured_at", "rank", "repo", "description", "language", "stars", "stars_period", "url")}`;
}

interface Snapshot { capturedAt: string; rows: TrendingRow[] }

async function readAt(db: Db, period: Period, at: Date): Promise<Snapshot | null> {
  const rows = await db<{ rank: number; repo: string; description: string | null; language: string | null; stars: number | null; stars_period: number | null; url: string }[]>`
    SELECT rank, repo, description, language, stars, stars_period, url
    FROM github_trending_snapshots WHERE period = ${period} AND captured_at = ${at} ORDER BY rank, id`;
  if (rows.length === 0) return null;
  return {
    capturedAt: at.toISOString(),
    rows: rows.map((r) => ({ rank: r.rank, repo: r.repo, description: r.description, language: r.language, stars: r.stars, starsPeriod: r.stars_period, url: r.url })),
  };
}

export async function latestSnapshot(db: Db, period: Period): Promise<Snapshot | null> {
  const [row] = await db<{ at: Date }[]>`SELECT max(captured_at) AS at FROM github_trending_snapshots WHERE period = ${period}`;
  return row?.at ? readAt(db, period, row.at) : null;
}

export async function snapshotAt(db: Db, period: Period, at: string): Promise<Snapshot | null> {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : readAt(db, period, d);
}

export async function listCaptures(db: Db, period: Period, limit = 30): Promise<{ capturedAt: string; count: number }[]> {
  const rows = await db<{ at: Date; n: number }[]>`
    SELECT captured_at AS at, count(*)::int AS n FROM github_trending_snapshots
    WHERE period = ${period} GROUP BY captured_at ORDER BY captured_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ capturedAt: r.at.toISOString(), count: r.n }));
}
