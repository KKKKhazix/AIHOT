// The model directory (database/seeds/lb-models-YYYY-MM-DD.json, the newest one): display names,
// providers and release dates, the name each evaluation source uses for a model, and the scale each
// evaluation protocol was frozen with (lb_calibrations). A new site imports it before the first round,
// so fetched rows resolve to the same models, names and brand marks as on AIHOT instead of one new model
// per unfamiliar name, and scores are measured on the same scales instead of ones frozen from whatever
// this site happens to see first. Rows already present are kept; a frozen scale never changes.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { importCalibrations } from "./method/inputs.ts";

const SEEDS = path.join(REPO_ROOT, "database/seeds");

interface Directory {
  /** [slug, name, provider, provider slug, release date, the source that release date follows] */
  models: Array<[string, string, string | null, string | null, string | null, (string | null)?]>;
  /** source key → the source's name for a model → model slug */
  aliases: Record<string, Record<string, string>>;
  /** lb_calibrations rows, as stored */
  calibrations?: Array<{ methodology_version: string; unit: string; protocol: string; calibration: Record<string, unknown> }>;
}

const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export async function importModelDirectory(): Promise<{ models: number; aliases: number; calibrations: number }> {
  const file = readdirSync(SEEDS).filter((f) => /^lb-models-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1);
  if (!file) throw new Error("database/seeds has no model directory (lb-models-YYYY-MM-DD.json)");
  const dir = JSON.parse(readFileSync(path.join(SEEDS, file), "utf8")) as Directory;
  let models = 0;
  for (const chunk of chunks(dir.models, 500)) {
    // Release dates are UTC days, as the fetchers store them, whatever the database's time zone.
    const rows = chunk.map(([slug, name, provider, providerSlug, releasedOn, releaseSource]) => ({
      id: createId(), slug, name, provider, provider_slug: providerSlug, released_at: releasedOn ? `${releasedOn}T00:00:00Z` : null,
      release_date_source: releasedOn ? (releaseSource ?? "directory") : null, metadata_source: "directory",
    }));
    const res = await sql`INSERT INTO lb_models ${sql(rows, "id", "slug", "name", "provider", "provider_slug", "released_at", "release_date_source", "metadata_source")}
                          ON CONFLICT (slug) DO NOTHING`;
    models += res.count;
  }
  const ids = new Map((await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models`).map((m) => [m.slug, m.id]));
  const aliasRows = Object.entries(dir.aliases).flatMap(([sourceKey, names]) =>
    Object.entries(names)
      .filter(([, slug]) => ids.has(slug))
      .map(([alias, slug]) => ({ id: createId(), source_key: sourceKey, alias, normalized_alias: slug, model_id: ids.get(slug)! })));
  let aliases = 0;
  for (const chunk of chunks(aliasRows, 1000)) {
    const res = await sql`INSERT INTO lb_aliases ${sql(chunk, "id", "source_key", "alias", "normalized_alias", "model_id")}
                          ON CONFLICT (source_key, alias) DO NOTHING`;
    aliases += res.count;
  }
  const calibrations = await importCalibrations(dir.calibrations ?? []);
  return { models, aliases, calibrations };
}
