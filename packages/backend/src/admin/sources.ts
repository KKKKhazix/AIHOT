// Source administration (F18): list, detail, preview (fetch without storing), edit, create with
// duplicate checks, pause/resume and manual collection. Every change is audited.
import { z } from "zod";
import type { AdminSource, AdminSourceCreated, AdminSourceDetail, AdminSourcePreview, AdminSourceRow, AdminSources, BeforeJson } from "@aihot/contracts/admin";
import { audit, auditHistory, Conflict } from "../audit.ts";
import { sql, type Db } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { invalidateStoryInputs } from "../events/derived-content.ts";
import { resumeSourceArticles } from "../jobs/content.ts";
import { republishKey } from "../jobs/publication.ts";
import { normalizeUrl } from "../lib/url.ts";
import { fetchJsonList } from "../sources/json-list.ts";
import { fetchRss } from "../sources/rss.ts";
import { assertSupportedConfig } from "../sources/config-keys.ts";
import type { SourceRow } from "../sources/types.ts";
import { fetchWebList } from "../sources/web-list.ts";
import { fetchXSearch } from "../sources/x.ts";


export interface SourceListFilters {
  q?: string;
  kind?: string;
  health?: string;
  enabled?: "true" | "false";
  mode?: string;
  page?: number;
}

export async function listSources(f: SourceListFilters): Promise<BeforeJson<AdminSources>> {
  const page = Math.max(1, f.page ?? 1);
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const rows = await sql<BeforeJson<AdminSourceRow>[]>`
    SELECT s.id, s.name, s.kind, s.tier, s.participation_mode, s.enabled, s.health, s.fail_count, s.interval_minutes,
           s.last_ok_at, s.last_fetch_at, s.last_error, s.first_party, s.next_fetch_at,
           (SELECT count(*)::int FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days') AS items_7d,
           coalesce(selected.n, 0) AS selected_30d
    FROM sources s
    LEFT JOIN (
      SELECT source_id, count(*)::int AS n FROM publications
      WHERE selected AND discovered_at > now() - interval '30 days' GROUP BY source_id
    ) selected ON selected.source_id = s.id
    WHERE (${q}::text IS NULL OR s.name ILIKE ${q} OR s.id ILIKE ${q} OR s.config::text ILIKE ${q})
      AND (${f.kind ?? null}::text IS NULL OR s.kind = ${f.kind ?? null})
      AND (${f.health ?? null}::text IS NULL OR s.health = ${f.health ?? null})
      AND (${f.mode ?? null}::text IS NULL OR s.participation_mode = ${f.mode ?? null})
      AND (${f.enabled ?? null}::text IS NULL OR s.enabled = (${f.enabled ?? null} = 'true'))
    ORDER BY s.enabled DESC, CASE s.health WHEN 'failing' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, s.name, s.id
    LIMIT 100 OFFSET ${(page - 1) * 100}`;
  const [totals] = await sql<{ total: number; enabled: number; failing: number; degraded: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS enabled,
           count(*) FILTER (WHERE health = 'failing')::int AS failing, count(*) FILTER (WHERE health = 'degraded')::int AS degraded
    FROM sources`;
  return { page, rows, totals };
}

export async function sourceDetail(id: string): Promise<BeforeJson<AdminSourceDetail> | null> {
  const [source] = await sql<BeforeJson<AdminSource>[]>`SELECT * FROM sources WHERE id = ${id}`;
  if (!source) return null;
  const runs = await sql<BeforeJson<AdminSourceDetail["runs"][number]>[]>`SELECT id, started_at, finished_at, status, found_count, new_count, error, detail FROM fetch_runs WHERE source_id = ${id} ORDER BY started_at DESC LIMIT 30`;
  const items = await sql<BeforeJson<AdminSourceDetail["items"][number]>[]>`
    SELECT a.id, a.title, a.url, a.discovered_at, a.published_at, a.processing_state, p.selected, p.visibility, p.title AS title_zh
    FROM articles a LEFT JOIN publications p ON p.article_id = a.id WHERE a.source_id = ${id} ORDER BY a.discovered_at DESC LIMIT 30`;
  const [stats] = await sql<AdminSourceDetail["stats"][]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE a.discovered_at > now() - interval '7 days')::int AS last7d,
           (SELECT count(*)::int FROM publications p WHERE p.source_id = ${id} AND p.selected) AS selected
    FROM articles a WHERE a.source_id = ${id}`;
  const history = await auditHistory(`source:${id}`);
  const [republish] = await sql<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = ${republishKey(id)}`;
  return { source, runs, items, stats: stats!, history, republish: republish?.value ?? null };
}

/** A stored source fetched now without storing anything; null when there is no such source. */
export async function previewStoredSource(id: string): Promise<BeforeJson<AdminSourcePreview> | null> {
  const [source] = await sql<SourceRow[]>`SELECT * FROM sources WHERE id = ${id}`;
  return source ? previewSource(source) : null;
}

export async function previewSource(draft: Pick<SourceRow, "id" | "kind" | "config"> & Partial<SourceRow>): Promise<BeforeJson<AdminSourcePreview>> {
  const source = { name: draft.id, enabled: true, cursor: null, tier: "T2", participation_mode: "editorial", ...draft } as SourceRow;
  assertSupportedConfig(source.kind, source.config);
  const started = Date.now();
  let candidates;
  if (source.kind === "rss") candidates = (await fetchRss(source, { force: true })).candidates;
  else if (source.kind === "web_list") candidates = await fetchWebList(source, { preview: true });
  else if (source.kind === "json_list") candidates = await fetchJsonList(source);
  else if (source.kind === "x_search") candidates = (await fetchXSearch(source)).candidates;
  else throw new Error(`preview is not available for ${source.kind} sources`);
  return {
    ms: Date.now() - started,
    count: candidates.length,
    items: candidates.slice(0, 20).map((c) => ({ title: c.title, url: c.url, publishedAt: c.publishedAt?.toISOString() ?? null, excerpt: (c.excerpt ?? c.bodyText ?? "").slice(0, 200) })),
  };
}

const EDITABLE = z
  .object({
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    interval_minutes: z.number().int().min(1).max(1440),
    tier: z.enum(["T1", "T1_5", "T2", "EXCLUDE_MP"]),
    participation_mode: z.enum(["editorial", "hot_signal", "isolated"]),
    signal_group_id: z.string().max(120).nullable(),
    first_party: z.boolean(),
    owner_entity_id: z.string().max(120).nullable(),
    site_fulltext: z.boolean(),
    syndicate_fulltext: z.boolean(),
    tags: z.array(z.string().max(60)).max(30),
    config: z.record(z.string(), z.unknown()),
  })
  .partial()
  .strict();

export async function updateSource(id: string, input: { patch: unknown; version: string; reason?: string }, actor: string) {
  const patch = EDITABLE.parse(input.patch);
  return sql.begin(async (tx) => {
    // Creation and address edits share the lock: checking then inserting must not race.
    if (patch.config) await tx`SELECT pg_advisory_xact_lock(hashtext('admin-source-identity'))`;
    const [before] = await tx`SELECT * FROM sources WHERE id = ${id} FOR UPDATE`;
    if (!before) return null;
    if (new Date(before.updated_at as Date).toISOString() !== input.version) throw new Conflict("信源已被其他操作修改，请刷新后再改");
    if (patch.config) {
      assertSupportedConfig(before.kind as SourceRow["kind"], patch.config);
      // A changed address must not be one another source already collects from. (Sources that share a
      // feed on purpose, with different filters, keep editing their other settings.)
      const moved = sourceIdentity(String(before.kind), patch.config) !== sourceIdentity(String(before.kind), before.config as Record<string, unknown>);
      const dup = moved ? await findDuplicateSource(String(before.kind), patch.config, id, tx) : null;
      if (dup) throw new Conflict(`与已有信源重复：${dup.name}（${dup.id}）`);
    }
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (!keys.length) return before;
    const values = Object.fromEntries(keys.map((k) => [k, k === "config" ? tx.json(patch.config as never) : patch[k]]));
    const [after] = await tx`UPDATE sources SET ${tx(values as never, ...(keys as string[]))}, updated_at = now(),
      health = CASE WHEN ${patch.enabled ?? null}::boolean IS FALSE THEN 'paused' WHEN ${patch.enabled ?? null}::boolean IS TRUE AND health = 'paused' THEN 'unknown' ELSE health END,
      next_fetch_at = CASE WHEN ${patch.enabled ?? null}::boolean IS TRUE THEN now() ELSE next_fetch_at END
      WHERE id = ${id} RETURNING *`;
    if (before.participation_mode !== "editorial" && after!.participation_mode === "editorial") {
      await resumeSourceArticles(id, tx);
    }
    if (before.participation_mode === "editorial" && after!.participation_mode !== "editorial") {
      const articles = await tx<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${id}`;
      await invalidateStoryInputs(tx, articles.map((row) => row.id), new Date());
    }
    await audit(actor, "source.update", `source:${id}`, input.reason ?? null, Object.fromEntries(keys.map((k) => [k, before[k]])), patch, { db: tx });
    // What public exits show for this source's articles is derived from these fields: re-derive them
    // all (in the worker) so a revoked licence or an isolated source stops on every exit.
    if (keys.some((k) => PUBLICATION_FIELDS.includes(k) && JSON.stringify(before[k]) !== JSON.stringify(patch[k]))) {
      await tx`INSERT INTO settings (key, value, updated_by) VALUES (${republishKey(id)}, ${tx.json({ status: "queued", queuedAt: new Date().toISOString() })}, ${actor})
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await enqueue(QUEUES.republishSource, { sourceId: id }, { singletonKey: id }, tx);
    }
    return after;
  });
}

/** Source fields the public projection reads (publication/rules.ts and the v1 payload). */
const PUBLICATION_FIELDS: string[] = ["participation_mode", "site_fulltext", "syndicate_fulltext", "tier", "name", "first_party", "owner_entity_id"];

const CreateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
    name: z.string().min(1).max(200),
    kind: z.enum(["rss", "web_list", "json_list", "x_search", "mp_account", "external"]),
    config: z.record(z.string(), z.unknown()),
    tier: z.enum(["T1", "T1_5", "T2", "EXCLUDE_MP"]).default("T2"),
    participation_mode: z.enum(["editorial", "hot_signal", "isolated"]).default("editorial"),
    interval_minutes: z.number().int().min(1).max(1440).default(30),
    first_party: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    site_fulltext: z.boolean().default(false),
    syndicate_fulltext: z.boolean().default(false),
  })
  .strict();

/** The address a source collects from, used to find duplicates before creating one. */
export function sourceIdentity(kind: string, config: Record<string, unknown>): string | null {
  const raw = (config.feedUrl ?? config.url ?? config.listUrl ?? config.endpoint ?? null) as string | null;
  if (kind === "x_search") {
    const m = /from:([A-Za-z0-9_]{1,15})/.exec(String(config.query ?? ""));
    return m ? `x:${m[1]!.toLowerCase()}` : null;
  }
  // A WeChat account is one account whichever id names it .
  if (kind === "mp_account") {
    const id = String(config.ghid ?? config.wxid ?? "").trim().toLowerCase();
    return id ? `mp:${id}` : null;
  }
  if (!raw) return null;
  try {
    return normalizeUrl(String(raw).replace(/^https:\/\/r\.jina\.ai\//, "")) ?? String(raw);
  } catch {
    return String(raw);
  }
}

export async function findDuplicateSource(kind: string, config: Record<string, unknown>, exceptId?: string, db: Db = sql) {
  const identity = sourceIdentity(kind, config);
  if (!identity) return null;
  const rows = await db<{ id: string; kind: string; config: Record<string, unknown>; name: string }[]>`SELECT id, kind, config, name FROM sources WHERE kind = ${kind}`;
  return rows.find((r) => r.id !== exceptId && sourceIdentity(r.kind, r.config) === identity) ?? null;
}

export async function createSource(input: unknown, actor: string): Promise<BeforeJson<AdminSourceCreated>> {
  const s = CreateSchema.parse(input);
  assertSupportedConfig(s.kind, s.config);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('admin-source-identity'))`;
    const dup = await findDuplicateSource(s.kind, s.config, undefined, tx);
    if (dup) return { created: false as const, duplicate: dup };
    const [row] = await tx<BeforeJson<AdminSource>[]>`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, first_party, tags, site_fulltext, syndicate_fulltext, next_fetch_at)
    VALUES (${s.id}, ${s.name}, ${s.kind}, ${tx.json(s.config as never)}, ${s.tier}, ${s.participation_mode}, ${s.interval_minutes}, ${s.first_party}, ${s.tags},
            ${s.site_fulltext}, ${s.syndicate_fulltext}, now())
    ON CONFLICT (id) DO NOTHING RETURNING *`;
    if (!row) throw new Conflict(`信源 ID ${s.id} 已存在`);
    await audit(actor, "source.create", `source:${s.id}`, null, null, s, { db: tx });
    return { created: true as const, source: row };
  });
}

export async function fetchNow(id: string, actor: string) {
  const [s] = await sql<{ id: string; kind: string }[]>`SELECT id, kind FROM sources WHERE id = ${id}`;
  if (!s) return null;
  const jobId =
    s.kind === "mp_account"
      ? await enqueue(QUEUES.mpCheck, { sourceId: id, reason: "manual" }, { singletonKey: `mp:${id}` })
      : await enqueue(QUEUES.fetchSource, { sourceId: id, force: true }, { singletonKey: `manual:${id}` });
  await audit(actor, "source.fetch", `source:${id}`, null, null, { jobId });
  return { jobId };
}
