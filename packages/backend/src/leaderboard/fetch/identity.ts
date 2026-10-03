// Model identity: a source's own names map to one model through lb_aliases. A name seen for the first
// time is matched by its base name's slug; otherwise a new model is created (its provider inferred, its
// release date from the source when it gives one) and the alias recorded, so the next fetch resolves
// directly. The source a release date came from keeps it current: an early listing date is corrected
// when that source corrects it.
import { createId } from "@paralleldrive/cuid2";
import { sql } from "../../db.ts";
import { inferProvider } from "../providers.ts";

/** "Llama 3 8B" → "llama-3-8-b"; "GPT-4o" → "gpt-4-o"; "v2.1" → "v-2-1". */
export function modelSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1-$2")
    .replace(/(\d)([a-z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Upstream-confirmed cloaked / early-testing names (OpenRouter stealth models). A later reveal names
 * the developer but does not prove the tested checkpoint is the released product, so their scores are
 * kept for audit and never represent a public model; the public rules say anonymous test names are
 * excluded. Only names confirmed as such belong here.
 */
const CLOAKED = new Set([
  "ox-alpha", "horizon-alpha", "horizon-beta", "pony-alpha", "hunter-alpha", "healer-alpha", "optimus-alpha", "quasar-alpha",
  "sherlock-dash-alpha", "bert-nebulon-alpha", "sonoma-sky-alpha", "cypher-alpha", "aurora-alpha",
]);

/** Whether any of a row's names (source name, model slug or name) is an anonymous test identity. */
export function cloakedModel(...names: Array<string | null | undefined>): boolean {
  return names.some((n) => {
    if (!n) return false;
    if (/^stealth[/_-]/i.test(n.trim())) return true;
    const s = modelSlug(n).replace(/^(?:openrouter|stealth)-/, "").replace(/(?:-(?:max|free))+$/, "");
    return CLOAKED.has(s);
  });
}

export class IdentityResolver {
  private aliases = new Map<string, string>();
  private slugs = new Map<string, string>();
  private releases = new Map<string, { date: string | null; source: string | null }>();
  private created: Array<{ id: string; slug: string; name: string }> = [];

  readonly sourceKey: string;
  private readonly dryRun: boolean;

  constructor(sourceKey: string, dryRun = false) {
    this.sourceKey = sourceKey;
    this.dryRun = dryRun;
  }

  async load() {
    const rows = await sql<{ alias: string; model_id: string }[]>`SELECT alias, model_id FROM lb_aliases WHERE source_key = ${this.sourceKey}`;
    for (const r of rows) this.aliases.set(r.alias, r.model_id);
    const models = await sql<{ id: string; slug: string; released_at: Date | null; release_date_source: string | null }[]>`
      SELECT id, slug, released_at, release_date_source FROM lb_models`;
    for (const m of models) {
      this.slugs.set(m.slug, m.id);
      this.releases.set(m.id, { date: m.released_at ? m.released_at.toISOString().slice(0, 10) : null, source: m.release_date_source });
    }
    return this;
  }

  /** Fills a missing release date, and follows the source the date came from when it changes it. */
  private async syncRelease(id: string, releasedAt: string | null | undefined) {
    const date = releasedAt && /^\d{4}-\d{2}-\d{2}/.test(releasedAt) ? releasedAt.slice(0, 10) : null;
    const known = this.releases.get(id);
    if (!date || !known || known.date === date || (known.date && known.source !== this.sourceKey)) return;
    this.releases.set(id, { date, source: this.sourceKey });
    if (!this.dryRun) {
      await sql`UPDATE lb_models SET released_at = ${`${date}T00:00:00Z`}, release_date_source = ${this.sourceKey}, updated_at = now() WHERE id = ${id}`;
    }
  }

  /** Resolves a row's names to a model id, creating the model and alias when needed. */
  async resolve(names: string[], baseName: string, meta: { organization?: string | null; releasedAt?: string | null } = {}): Promise<string> {
    for (const n of names) {
      const hit = this.aliases.get(n);
      if (hit) {
        await this.syncRelease(hit, meta.releasedAt);
        return hit;
      }
    }
    const slug = modelSlug(baseName);
    let id = this.slugs.get(slug);
    if (id) await this.syncRelease(id, meta.releasedAt);
    if (!id) {
      id = createId();
      this.slugs.set(slug, id);
      this.created.push({ id, slug, name: baseName });
      this.releases.set(id, { date: meta.releasedAt?.slice(0, 10) ?? null, source: meta.releasedAt ? this.sourceKey : null });
      if (!this.dryRun) {
        const provider = inferProvider(baseName, meta.organization);
        await sql`
          INSERT INTO lb_models (id, slug, name, provider, provider_slug, released_at, release_date_source, metadata_source, created_at, updated_at)
          VALUES (${id}, ${slug}, ${baseName}, ${provider?.name ?? meta.organization ?? "其他"}, ${provider?.slug ?? "other"}, ${meta.releasedAt ?? null}, ${meta.releasedAt ? this.sourceKey : null}, ${this.sourceKey}, now(), now())
          ON CONFLICT (slug) DO NOTHING`;
        const [row] = await sql<{ id: string }[]>`SELECT id FROM lb_models WHERE slug = ${slug}`;
        id = row!.id;
        this.slugs.set(slug, id);
      }
    }
    for (const n of names) {
      this.aliases.set(n, id);
      if (!this.dryRun) {
        await sql`INSERT INTO lb_aliases (id, source_key, alias, normalized_alias, model_id) VALUES (${createId()}, ${this.sourceKey}, ${n}, ${slug}, ${id})
                  ON CONFLICT DO NOTHING`;
      }
    }
    return id;
  }

  get newModels() {
    return this.created;
  }

  /** Model id → slug for every model this resolver knows: all stored ones and those it created. */
  get slugsById() {
    return new Map([...this.slugs].map(([slug, id]) => [id, slug]));
  }
}
