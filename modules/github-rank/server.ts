// The github-rank collector. The engine has no reader for "a file that appears once a week at a dated
// path", so this module does that read itself and hands the result to the engine through upsertMaterial —
// the same entrance every other channel uses, so identity, the timeline rule, judging, grouping and
// publication all apply unchanged.
//
// One item per ranked project, not one per edition. A single article carrying twenty projects is judged
// scope=composite ("one article reporting several happenings"), and the event graph gives a composite no
// fact and no story signal (events/group.ts, verdict "roundup") — so it can neither join a story, nor be
// picked up when another source covers the same project, nor appear in the hot ranking. Split per project,
// each is one fact that stands on its own.
//
// Why a module instead of a configured source: the ranking itself lives inside the upstream Markdown file,
// and no listing kind carries it. A json_list source can only point at the commits API, which would store a
// bare "2026.10.12周飙升榜" title plus a link whose page github.com answers with 503 to this host — an
// article with neither body nor summary, which the public pool then drops. Reading the file's own bytes and
// stating its facts is what makes the ranking usable material.
//
// api.github.com is the one GitHub host this deployment reaches reliably (github.com and
// raw.githubusercontent.com time out here), hence contentsApiUrl() and the raw media type.
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { defineQueue, defineServerModule, type ModuleQueue, type Scheduled } from "@aihot/backend/modules";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { candidateMondays, contentsApiUrl, filePathFor, parseWeeklyRank, projectBody, projectTitle } from "./rank.ts";

/** The source row the material is attributed to (seeded from industry/sources.json). */
export const SOURCE_ID = "github-rank";

interface FetchJob {
  /** The Monday to read ("20261012"); absent means "resolve the newest available edition". */
  day?: string;
}

const fetchQueue: ModuleQueue<FetchJob> = defineQueue<FetchJob>({
  name: "github-rank.fetch",
  options: { policy: "singleton", retryLimit: 2, retryDelay: 300, expireInSeconds: 300 },
  worker: { pollingIntervalSeconds: 15 },
  // A batch is one due check, so reading the newest edition once covers every job in it.
  run: async (jobs) => collectGitHubRank(jobs.find((job) => job.day)?.day),
});

/**
 * One edition's bytes. `Accept: application/vnd.github.raw` makes the contents API return the file's own
 * Markdown instead of its base64 envelope. A missing file is a normal outcome (that week's edition is not
 * out yet), so the caller walks back through candidate Mondays rather than treating it as a failure.
 */
async function readFile(day: string): Promise<{ md: string; file: string } | null> {
  const file = filePathFor(day);
  const headers: Record<string, string> = { accept: "application/vnd.github.raw" };
  // Optional: lifts the 60-per-hour unauthenticated limit where a token is configured.
  const token = credential("collectors", "GITHUB_TOKEN");
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await guardedFetch(contentsApiUrl(file), { timeoutMs: 25_000, maxBytes: 4 * 1024 * 1024, headers });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`HTTP ${res.status} reading ${file}`);
  const md = res.text();
  // A truncated or error body can still answer 200: refuse anything without the ranked table rather than
  // store a revision that says less than the one already held.
  if (md.length < 500 || !/\|/.test(md)) throw new Error(`unexpected body for ${file} (${md.length} bytes)`);
  return { md, file };
}

/**
 * Stores one edition as one item per ranked project. The identity is the edition plus the repository, so
 * re-reading the same week revises rather than duplicates, and next week's edition of the same project is
 * a new item rather than a revision of this one.
 *
 * The URL carries the project as a fragment, and that is load bearing: grouping treats two items with the
 * same URL as the same event (events/recall.ts relatedPosts compares the stored URL), so all twenty items
 * pointing at the bare edition page would collapse into one story. The fragment keeps them apart, and it
 * still resolves to the edition page that lists every project.
 */
async function store(day: string, md: string): Promise<{ created: number; revised: number; items: number; file: string }> {
  const rank = parseWeeklyRank(md, day);
  if (rank.items.length === 0) throw new Error(`no ranked rows in ${rank.file}`);
  let created = 0;
  let revised = 0;
  for (const item of rank.items) {
    const res = await upsertMaterial({
      sourceId: SOURCE_ID,
      url: `${rank.sourceUrl}#${item.repo.replace("/", "-")}`,
      identityKey: `github-rank:${rank.file}:${item.repo}`,
      title: projectTitle(rank, item),
      publishedAt: rank.publishedAt,
      // The body states this project's figures and attribution; upstream's own prose is never copied
      // (the repository carries no licence).
      bodyText: projectBody(rank, item),
      bodyStatus: "ok",
      raw: { externalId: `${rank.file}#${item.repo}`, repo: item.repo, rank: item.rank, edition: rank.window, sourceUrl: rank.sourceUrl },
      via: "fetch",
    });
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    // Body is already confirmed, so this routes straight to judging (jobs/content.ts).
    if (res.created || res.revised || res.processingNeeded) await queueProcessing(res.articleId);
  }
  return { created, revised, items: rank.items.length, file: rank.file };
}

/** Records one collection run like an engine collector: a fetch_runs row and the source's own health. */
async function record(ok: boolean, detail: Record<string, unknown>, error?: string): Promise<void> {
  if (ok) {
    await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
      health = 'ok', cursor = ${sql.json({ lastEdition: detail.file ?? null } as never)},
      next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now()
      WHERE id = ${SOURCE_ID}`;
    return;
  }
  await sql`UPDATE sources SET last_fetch_at = now(), fail_count = fail_count + 1, last_error = ${error ?? null},
    health = CASE WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
    next_fetch_at = now() + make_interval(mins => LEAST(interval_minutes * (fail_count + 2), 360)), updated_at = now()
    WHERE id = ${SOURCE_ID}`;
}

/** One collection run for the github-rank source. */
export async function collectGitHubRank(day?: string): Promise<Record<string, unknown>> {
  const [source] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM sources WHERE id = ${SOURCE_ID}`;
  if (!source) return { sourceId: SOURCE_ID, status: "skipped", error: "missing" };
  if (!source.enabled) return { sourceId: SOURCE_ID, status: "skipped", error: "paused" };

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${SOURCE_ID}) RETURNING id`;
  try {
    let resolved: { day: string; md: string } | null = null;
    if (day) {
      const got = await readFile(day);
      resolved = got ? { day, md: got.md } : null;
    } else {
      for (const candidate of candidateMondays(new Date())) {
        const got = await readFile(candidate);
        if (got) { resolved = { day: candidate, md: got.md }; break; }
      }
    }
    // No edition in the last six weeks is not the source's failure: upstream may be late, and the next run
    // picks it up. It is recorded as an empty success so the health signal stays honest.
    if (!resolved) {
      await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = 0, new_count = 0,
        detail = ${sql.json({ note: "no edition within 6 weeks" })} WHERE id = ${run!.id}`;
      await record(true, {});
      return { sourceId: SOURCE_ID, status: "ok", found: 0, created: false, error: "no edition yet" };
    }

    const stored = await store(resolved.day, resolved.md);
    const detail = { file: stored.file, items: stored.items, created: stored.created, revised: stored.revised };
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${stored.items},
      new_count = ${stored.created}, detail = ${sql.json(detail as never)} WHERE id = ${run!.id}`;
    await record(true, detail);
    return { sourceId: SOURCE_ID, status: "ok", found: stored.items, ...detail };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), error = ${message} WHERE id = ${run!.id}`;
    await record(false, {}, message);
    return { sourceId: SOURCE_ID, status: "failed", found: 0, created: false, error: message };
  }
}

/**
 * Daily at 08:10 Beijing, ten minutes after upstream publishes. Upstream commits each edition at
 * Monday 00:00 UTC — 08:00 Beijing, observed to the second across the last 50 editions — so the old
 * 03:10 check was almost a full day behind: Monday's edition only reached the site on Tuesday.
 *
 * Ten minutes of headroom covers the commit itself; the rare edition that lands later in the day (a
 * handful of the last 50, up to ~17:00) is picked up by the next day's run, and the push's per-edition
 * guard means it is still delivered exactly once. Every other day this re-reads the same file — one
 * small request — and the material's own identity makes it a no-op.
 *
 * Collection is one API call with no model work; the analysis it queues runs on the local model like
 * everything else, so this needs no place inside the 02:00–07:00 sweep window.
 */
const dailyCheck: Scheduled = {
  name: "github-rank.check",
  cron: "10 8 * * *",
  missed: "once",
  run: () => enqueueOn(fetchQueue, {}),
  // Collection is the engine's external-action valve; honour it like every other collector.
  when: () => process.env.COLLECT_ENABLED === "true",
};

/**
 * The weekly source report's line for this collector. The engine's source health only covers the kinds it
 * collects itself (sources that are pushed to, like every `external` source, are not in it), so a collector
 * that wants its own health reported says it here.
 */
async function healthLine(): Promise<string[]> {
  const [row] = await sql<{ health: string; fail_count: number; last_ok_at: Date | null; last_error: string | null; editions: number }[]>`
    SELECT s.health, s.fail_count, s.last_ok_at, left(s.last_error, 200) AS last_error,
      (SELECT count(*)::int FROM fetch_runs r WHERE r.source_id = s.id AND r.status = 'ok' AND r.new_count > 0) AS editions
    FROM sources s WHERE s.id = ${SOURCE_ID}`;
  if (!row) return [];
  const state = row.last_error ? `最近一次失败：${row.last_error}` : `已收录 ${row.editions} 期`;
  return [`GitHub 周飙升榜（${SOURCE_ID}）：健康 ${row.health}；连续失败 ${row.fail_count} 次；${state}`];
}

export default defineServerModule({
  name: "github-rank",
  queues: [fetchQueue],
  schedules: [dailyCheck],
  sourceHealth: healthLine,
  // The admin's source page reads one edition on demand. Only this source belongs to this module: every
  // other external source is push-only (the ingest API), so the honest answer for those is a skip rather
  // than the engine's silent one. The read itself is queued, like the engine's own collectors, so the
  // request is not held for the whole upstream fetch.
  sourceKinds: {
    external: {
      fetchNow: async (source) => {
        if (source.id !== SOURCE_ID) return { skipped: true, reason: "external sources receive content through the ingest API" };
        return { jobId: await enqueueOn(fetchQueue, {}, { singletonKey: fetchQueue.name }) };
      },
    },
  },
});
