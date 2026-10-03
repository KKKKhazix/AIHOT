// Official API prices (lb_prices kind='official'), kept as dated files in database/seeds
// (lb-official-prices-YYYY-MM-DD.json); a newer file adds models or replaces their earlier entries. Each
// refresh fills in the models that have no price yet; scripts/import-leaderboard-prices.ts rewrites them
// all after a file is added. An entry with no prices and a note records that the vendor sells no paid
// API for that model.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";

const SEEDS = path.join(REPO_ROOT, "database/seeds");
const PRICE_FILE = /^lb-official-prices-\d{4}-\d{2}-\d{2}\.json$/;

/** [currency, input, output, cached input, source url, note], per million tokens */
type Price = [string, number | null, number | null, number | null, string, string?];

/** Each model's newest entry, from one file or from every dated file (later files win). */
function seededPrices(file?: string): Map<string, { verifiedOn: string; price: Price }> {
  const files = file ? [file] : readdirSync(SEEDS).filter((f) => PRICE_FILE.test(f)).sort().map((f) => path.join(SEEDS, f));
  const out = new Map<string, { verifiedOn: string; price: Price }>();
  for (const f of files) {
    const seed = JSON.parse(readFileSync(f, "utf8")) as { verifiedOn: string; prices: Record<string, Price> };
    for (const [slug, price] of Object.entries(seed.prices)) out.set(slug, { verifiedOn: seed.verifiedOn, price });
  }
  return out;
}

export async function importOfficialPrices(opts: { file?: string; overwrite?: boolean } = {}): Promise<{ written: number; unknown: string[] }> {
  let written = 0;
  const unknown: string[] = [];
  for (const [slug, { verifiedOn, price: [currency, input, output, cached, url, note] }] of seededPrices(opts.file)) {
    const [model] = await sql<{ id: string }[]>`SELECT id FROM lb_models WHERE slug = ${slug}`;
    if (!model) {
      unknown.push(slug);
      continue;
    }
    const res = await sql`
      INSERT INTO lb_prices (model_id, kind, currency, input, output, cached_input, source_url, verified_on, note)
      VALUES (${model.id}, 'official', ${currency}, ${input}, ${output}, ${cached}, ${url}, ${verifiedOn}, ${note ?? null})
      ON CONFLICT (model_id, kind) DO ${opts.overwrite
        ? sql`UPDATE SET currency = EXCLUDED.currency, input = EXCLUDED.input, output = EXCLUDED.output, cached_input = EXCLUDED.cached_input,
                source_url = EXCLUDED.source_url, verified_on = EXCLUDED.verified_on, note = EXCLUDED.note, updated_at = now()`
        : sql`NOTHING`}`;
    written += res.count;
  }
  return { written, unknown };
}
