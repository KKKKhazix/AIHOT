// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { sql, type Db } from "../db.ts";
import { identityKeyFor, STALE_ON_DISCOVERY_MS, upsertMaterial } from "../content/materials.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { sha256 } from "../lib/ids.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { fetchRss } from "./rss.ts";
import { allowed, fetchDetail, fetchWebList, isCallToActionTitle, needsTitle, type DetailNeed } from "./web-list.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { filterPublicationWindow } from "./filters.ts";
import { fetchJsonList } from "./json-list.ts";
import { fetchXSearch, planXShards, readXSearch, shardHandle, shardQuery, selfThreadHandle, SHARDABLE_SQL, tweetToCandidate, type XBacklog } from "./x.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  error?: string;
}

export function noiseFiltered(c: Candidate, source: SourceRow): boolean {
  const f = source.config.ingestNoiseFilter;
  const cats: string[] = c.categories ?? [];
  if (source.config.denyCategories?.some((d: string) => cats.includes(d))) return true;
  if (source.config.allowCategories?.length && !source.config.allowCategories.some((a: string) => cats.includes(a))) return true;
  if (!f) return false;
  // Case-insensitive: the exemption "agent" keeps "Agent" (words in the lists are lower case).
  const has = (text: string, words: string[] | undefined) => (words ?? []).some((k) => text.includes(k.toLowerCase()));
  const title = c.title.toLowerCase();
  const hay = `${title}\n${(c.excerpt ?? "").toLowerCase()}`;
  if (has(hay, f.keepIfMatches)) return false;
  return has(title, f.dropMarkersTitleOnly) || has(hay, f.dropMarkers);
}

function rewriteUrl(c: Candidate, source: SourceRow): Candidate {
  const rw = source.config.itemUrlPrefixRewrite;
  if (rw?.from && rw?.to && c.url.startsWith(rw.from)) return { ...c, url: rw.to + c.url.slice(rw.from.length) };
  return c;
}

async function loadSource(id: string): Promise<SourceRow | null> {
  const [s] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${id}`;
  return s ?? null;
}

interface StoredDetail {
  identity_key: string;
  title: string;
  published_at: Date | null;
  excerpt: string | null;
  body_status: string;
  rules: string | null;
}

async function storedDetails(identities: string[]): Promise<Map<string, StoredDetail>> {
  if (identities.length === 0) return new Map();
  // One array parameter: a long listing would exceed the query's parameter limit.
  const rows = await sql<StoredDetail[]>`SELECT identity_key, title, published_at, excerpt, body_status,
    raw->'collectionDetail'->>'rules' AS rules
    FROM articles WHERE identity_key = ANY(${identities}::text[])`;
  return new Map(rows.map((r) => [r.identity_key, r]));
}

const DAY_MS = 86_400_000;

type CollectionCandidate = Candidate & { detailRules?: string };

async function store(sourceId: string, candidates: CollectionCandidate[], backfill: string | null): Promise<{ created: number; revised: number }> {
  let created = 0;
  let revised = 0;
  for (const c of candidates) {
    const material = { ...c, sourceId, via: "fetch" as const, backfill };
    const res = await upsertMaterial(material);
    // A successful page with no matching field is complete too. Otherwise an undated article at
    // the front of a listing would consume the detail budget forever and strand the remaining ones.
    if (c.detailRules) await sql`UPDATE articles SET raw = jsonb_set(
      CASE WHEN jsonb_typeof(raw) = 'object' THEN raw ELSE '{}'::jsonb END,
      '{collectionDetail}', ${sql.json({ rules: c.detailRules })}) WHERE id = ${res.articleId} AND source_id = ${sourceId}`;
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    // Extraction first when the source wants full text and none came with the listing, else analysis.
    if (res.created || res.revised || res.processingNeeded) await queueProcessing(res.articleId);
  }
  return { created, revised };
}

/**
 * The end of a fetch run, on the run and on its source. Success marks the source healthy and due again
 * one interval later. A failure counts toward "failing" (5 in a row) and waits longer after each one,
 * up to six hours; a full budget is not the source's failure: it waits 15 minutes and counts nothing.
 */
async function recordFetch(db: Db, sourceId: string, runId: number, run: { found: number; created: number; detail: object | null } & ({ cursor: Record<string, unknown> } | { error: string; budget: boolean })): Promise<void> {
  const detail = run.detail ? db.json(run.detail as never) : null;
  if ("cursor" in run) {
    await db`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
        health = 'ok', cursor = ${db.json(run.cursor as never)}, updated_at = now(),
        next_fetch_at = now() + make_interval(mins => interval_minutes)
      WHERE id = ${sourceId}`;
    await db`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${run.found}, new_count = ${run.created}, detail = ${detail} WHERE id = ${runId}`;
    return;
  }
  await db`
    UPDATE sources SET last_fetch_at = now(),
      fail_count = CASE WHEN ${run.budget} THEN fail_count ELSE fail_count + 1 END,
      last_error = ${run.error},
      health = CASE WHEN ${run.budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
      next_fetch_at = now() + make_interval(mins => CASE WHEN ${run.budget} THEN 15 ELSE LEAST(interval_minutes * (fail_count + 2), 360) END),
      updated_at = now()
    WHERE id = ${sourceId}`;
  await db`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${run.found}, new_count = ${run.created},
              error = ${run.error}, detail = ${detail} WHERE id = ${runId}`;
}

export async function collectSource(sourceId: string, opts: { force?: boolean } = {}): Promise<CollectResult> {
  const source = await loadSource(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  if (!source.enabled && !opts.force) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  if (source.kind === "mp_account" || source.kind === "external") {
    // WeChat accounts are reconciled by the mp job; external sources only receive reports.
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  const firstImport = !source.cursor?.initializedAt;
  let created = 0;
  let revised = 0;
  let found = 0;
  try {
    // A config entry this kind does not implement fails the run, visibly, instead of being ignored.
    const unsupported = unsupportedConfig(source.kind, source.config);
    if (unsupported.length) throw new FetchError(`unsupported config: ${unsupported.join(", ")}`);
    let candidates: CollectionCandidate[];
    let paidReceiptIds: number[] = [];
    let nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let detail: Record<string, unknown> | null = null;
    const d = source.config.detail;
    const detailRules = d ? sha256(JSON.stringify(d)) : null;
    if (source.kind === "rss") {
      // Changed detail rules require the listing again even when its bytes did not change.
      const rss = await fetchRss(source, { force: opts.force || !!detailRules && source.cursor?.detailRules !== detailRules });
      candidates = rss.candidates;
      // The first import keeps only part of the listing: the next run reads all of it once before
      // accepting 304s, for the recent entries the import left out. Persist validators only after store succeeds.
      if (!firstImport) nextCursor.rss = rss.validator;
      else delete nextCursor.rss;
      if (rss.notModified) detail = { notModified: true, httpStatus: 304 };
    }
    else if (source.kind === "web_list") candidates = await fetchWebList(source);
    else if (source.kind === "json_list") candidates = await fetchJsonList(source);
    else {
      const x = await fetchXSearch(source);
      candidates = x.candidates;
      paidReceiptIds = x.receiptIds;
      if (x.lastId) nextCursor.lastTweetId = x.lastId;
      // A search longer than one run keeps its position for the next runs (shown in the admin).
      if (x.backlog.length) nextCursor.xBacklog = x.backlog;
      else delete nextCursor.xBacklog;
      detail = { pages: x.pages, truncated: x.truncated, backlog: x.backlog.length, backlogPages: x.backlogPages, dropped: x.dropped };
    }
    found = candidates.length;
    candidates = candidates.filter((c) => allowed(c.url, source)).map((c) => rewriteUrl(c, source)).filter((c) => !noiseFiltered(c, source));
    candidates = filterPublicationWindow(candidates, source.config.publishedAfter);
    if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    // Deduplicate before enrichment and limits: URL aliases must neither buy duplicate detail reads
    // nor crowd other articles out of the window. Use exactly the identity the material will store; a
    // source whose entries are sections of one page (#september-24-2026 …) keeps their fragments in it.
    const unique = new Map<string, Candidate>();
    for (const c of candidates) {
      const identityKey = c.identityKey
        ?? (source.config.preserveUrlFragment === true ? identityKeyForUrl(c.url, { keepFragment: true }) : null)
        ?? identityKeyFor({ ...c, sourceId, via: "fetch" });
      if (!unique.has(identityKey)) unique.set(identityKey, { ...c, identityKey });
    }
    candidates = [...unique.values()];
    // Listing dates marked unreliable are dropped before archive admission; the detail page's rule decides.
    if (d?.publishedAtAuthoritative === true) for (const c of candidates) c.publishedAt = null;
    // Admission of old archive entries and detail recovery both need the same stored identities.
    // A later date correction must still reach material that was already admitted without a date.
    const known = d || (!firstImport && source.kind !== "x_search")
      ? await storedDetails(candidates.map((c) => c.identityKey!)) : new Map<string, StoredDetail>();
    // First import of a new source: bounded, and archived by source time (never "today", never pushed).
    const backfillLimit = Number(source.config._aihot?.initialBackfillLimit ?? 30);
    const backfillMonths = Number(source.config._aihot?.initialBackfillMonths ?? 12);
    if (firstImport) {
      const cutoff = Date.now() - backfillMonths * 30 * 86400000;
      candidates = candidates.filter((c) => !c.publishedAt || !Number.isFinite(c.publishedAt.getTime()) || c.publishedAt.getTime() >= cutoff).slice(0, backfillLimit);
    } else if (source.kind !== "x_search") {
      // Later runs admit new identities only when published since the source was added, less the stale-on-discovery
      // window: a long listing's archive comes in through the bounded first import alone. Existing identities
      // still accept corrections. The listing's date decides; an undated entry passes and waits for a date as material (dropping one a detail page
      // dates would buy the same read again on every run). An X search is bounded by its watermark. Nothing
      // is cut by count: the cursor (an RSS validator) moves past the whole listing, so a recent entry cut
      // here would never be offered again.
      const floor = Date.parse(String(source.cursor!.initializedAt)) - STALE_ON_DISCOVERY_MS;
      candidates = candidates.filter((c) => known.has(c.identityKey!) || !(c.publishedAt && c.publishedAt.getTime() < floor));
    }

    // Detail pages fill missing fields within the per-run budget. Material stored before that budget
    // ran out, or during a failed detail read, can finish on a later listing run.
    const detailBudget = Number(d?.maxFetches ?? 0);
    let detailUsed = 0;
    let detailPending = 0;
    const detailErrors: Array<{ url: string; error: string }> = [];
    for (const c of candidates) {
      const stored = known.get(c.identityKey!);
      const storedHeadline = !!stored && isCallToActionTitle(c.title) && !isCallToActionTitle(stored.title);
      if (stored !== undefined) {
        // The title came from the detail page: the listing's own rendering must not revise it back.
        if (d?.titleSelector || d?.titleRegex) c.title = stored.title;
        if (stored.rules === detailRules) continue;
      }
      if (!d) continue;
      const need: DetailNeed = {
        date: !(stored?.published_at || c.publishedAt) || d.upgradeDatePrecision === true,
        title: !!(d.titleSelector || d.titleRegex) && (d.titleAuthoritative === true || (!storedHeadline && needsTitle(c.title))),
        summary: !!d.summarySelector && !(stored?.excerpt || c.excerpt),
        body: source.participation_mode === "editorial" && stored?.body_status !== "ok" && !c.bodyText && (!c.bodyStatus || c.bodyStatus === "pending"),
      };
      if (!need.date && !need.title && !need.summary) continue;
      if (detailUsed >= detailBudget) { detailPending += 1; continue; }
      detailUsed += 1;
      try {
        const got = await fetchDetail(c.url, source, need);
        c.detailRules = detailRules!;
        if (got.title) c.title = got.title;
        if (got.summary) c.excerpt = got.summary;
        // The same Readability path as extraction, using bytes already fetched for the detail rules.
        // A confirmed body enters through normal material revisions and skips the redundant fetch job.
        if (got.body) {
          c.bodyHtml = got.body.html;
          c.bodyText = got.body.text;
          c.bodyStatus = "ok";
          if (!c.media?.length) c.media = got.body.images;
          if (!d.publishedAtAuthoritative && !c.publishedAt && got.body.publishedAt) c.publishedAt = got.body.publishedAt;
        }
        // A date-only listing value gives way to the detail page's time on the same day.
        if (got.publishedAt && (!c.publishedAt || Math.abs(got.publishedAt.getTime() - c.publishedAt.getTime()) < DAY_MS)) c.publishedAt = got.publishedAt;
      } catch (error) {
        detailPending += 1;
        detailErrors.push({ url: c.url, error: String(error instanceof Error ? error.message : error).slice(0, 300) });
      }
    }
    if (d) {
      detail = { ...detail, detailAttempts: detailUsed, detailFailures: detailErrors.length, detailPending, detailErrors };
      nextCursor.detailRules = detailRules;
      // A validator covers the whole listing: accept 304 only after its detail work is complete.
      if (source.kind === "rss" && detailPending > 0) delete nextCursor.rss;
    } else delete nextCursor.detailRules;

    ({ created, revised } = await store(sourceId, candidates, firstImport ? "first-import" : null));

    if (firstImport) nextCursor.initializedAt = new Date().toISOString();
    nextCursor.lastOkAt = new Date().toISOString();
    await sql.begin(async (tx) => {
      await recordFetch(tx, sourceId, run!.id, { found, created, detail, cursor: nextCursor });
      for (const receiptId of paidReceiptIds) await completeReceipt(tx, receiptId);
    });
    return { sourceId, status: "ok", found, created, revised };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    await recordFetch(sql, sourceId, run!.id, { found, created, detail: null, error: message, budget: error instanceof BudgetExceededError });
    return { sourceId, status: "failed", found, created, revised, error: message };
  }
}

/** X ids begin with their millisecond timestamp (since 2010-11-04): the smallest id of a post made at `ms`. */
const xIdAt = (ms: number) => (BigInt(Math.max(0, ms - 1288834974657)) << 22n);

/**
 * Where an account's posts are known to be read up to. A quiet account's newest post can be months
 * old, but its last successful check read everything up to then; bounding a shard's search by the
 * post alone would re-read months of the other accounts' posts. Ten minutes before the check allows
 * for posts that reach the search late.
 */
function coveredTo(m: SourceRow): bigint {
  const own = BigInt(m.cursor!.lastTweetId);
  const checked = Date.parse(String(m.cursor?.lastOkAt ?? ""));
  if (!Number.isFinite(checked)) return own;
  const byTime = xIdAt(checked - 10 * 60_000);
  return byTime > own ? byTime : own;
}

/**
 * One search for a shard of X accounts (planXShards). Each post goes to the source whose handle wrote
 * it, and every account keeps its own fetch run, health and cursor. The oldest watermark bounds the
 * search, so no account misses a post (the others only see posts they already have again); afterwards
 * every account is covered up to the newest post the search saw, and the stretches still unread are
 * kept in each account's cursor, so they survive a change of shards.
 */
export async function collectXShard(key: string, sourceIds: string[]): Promise<{ key: string; status: "ok" | "failed" | "skipped"; accounts: number; found: number; created: number; error?: string }> {
  const members = (
    await sql<SourceRow[]>`
      SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
      FROM sources WHERE id IN ${sql(sourceIds)} ORDER BY id`
  ).filter((m) => m.enabled && shardHandle(m));
  if (members.length === 0) return { key, status: "skipped", accounts: 0, found: 0, created: 0 };
  const runs = new Map((await sql<{ id: number; source_id: string }[]>`
    INSERT INTO fetch_runs ${sql(members.map(m => ({ source_id: m.id })), "source_id")} RETURNING id, source_id`
  ).map(r => [r.source_id, r.id]));
  let found = 0;
  let created = 0;
  try {
    const since = members.map(coveredTo).reduce((a, b) => (b < a ? b : a));
    const backlog: XBacklog[] = [];
    const stretches = new Set<string>();
    for (const m of members) {
      for (const b of (Array.isArray(m.cursor?.xBacklog) ? m.cursor.xBacklog : []) as XBacklog[]) {
        if (!stretches.has(`${b.query} ${b.next}`)) backlog.push(b);
        stretches.add(`${b.query} ${b.next}`);
      }
    }
    const read = await readXSearch(shardQuery(members.map((m) => shardHandle(m)!), members.map(selfThreadHandle).filter((h): h is string => h !== null)), { lastId: String(since), backlog, subject: `x-shard:${key}` });
    const detail = { shard: key, accounts: members.length, pages: read.pages, truncated: read.truncated, backlog: read.backlog.length, backlogPages: read.backlogPages, dropped: read.dropped };
    const counts = new Map<string, { found: number; created: number }>();
    for (const m of members) {
      const handle = shardHandle(m)!.toLowerCase();
      const mine = read.tweets.filter((t) => t.user.screen_name.toLowerCase() === handle);
      const stored = await store(m.id, mine.map(tweetToCandidate).map((c) => rewriteUrl(c, m)).filter((c) => !noiseFiltered(c, m)), null);
      found += mine.length;
      created += stored.created;
      counts.set(m.id, { found: mine.length, created: stored.created });
    }
    // Only a fully stored search advances coverage. A failed write can replay every paid page;
    // material already committed is idempotent, and no member is left half-finished.
    await sql.begin(async tx => {
      for (const m of members) {
        const own = String(m.cursor!.lastTweetId);
        const cursor: Record<string, unknown> = { ...m.cursor, lastTweetId: read.lastId && BigInt(read.lastId) > BigInt(own) ? read.lastId : own, lastOkAt: new Date().toISOString() };
        if (read.backlog.length) cursor.xBacklog = read.backlog;
        else delete cursor.xBacklog;
        await recordFetch(tx, m.id, runs.get(m.id)!, { ...counts.get(m.id)!, detail, cursor });
      }
      for (const receiptId of read.receiptIds) await completeReceipt(tx, receiptId);
    });
    return { key, status: "ok", accounts: members.length, found, created };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    for (const m of members) {
      await recordFetch(sql, m.id, runs.get(m.id)!, { found: 0, created: 0, detail: { shard: key, accounts: members.length }, error: message, budget });
    }
    return { key, status: "failed", accounts: members.length, found, created, error: message };
  }
}

/** X accounts read by shard: a plain query and a watermark (the first fetch of an account is its own). */
const sharded = () => sql`kind = 'x_search' AND config->>'query' ~* ${SHARDABLE_SQL} AND coalesce(config->>'searchType', 'Latest') = 'Latest' AND cursor->>'lastTweetId' IS NOT NULL`;

/** Every minute: a shard is read when any of its accounts is due, all of them at once. */
async function scheduleXShards(): Promise<number> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode"> & { due: boolean }>>`
    SELECT id, kind, config, cursor, participation_mode, (next_fetch_at IS NULL OR next_fetch_at <= now()) AS due
    FROM sources WHERE enabled AND ${sharded()}`;
  const due = new Set(rows.filter((r) => r.due).map((r) => r.id));
  let enqueued = 0;
  for (const shard of planXShards(rows)) {
    if (!shard.sourceIds.some((id) => due.has(id))) continue;
    if (await enqueue(QUEUES.fetchXShard, { key: shard.key, sourceIds: shard.sourceIds }, { singletonKey: shard.key })) enqueued += 1;
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id IN ${sql(shard.sourceIds)}`;
  }
  return enqueued;
}

/** Every minute: enqueue due sources (enabled, not WeChat/external), oldest due first; X accounts by shard. */
export async function scheduleDueSources(): Promise<{ enqueued: number; shards: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE enabled AND kind IN ('rss', 'web_list', 'json_list', 'x_search') AND (next_fetch_at IS NULL OR next_fetch_at <= now()) AND NOT (${sharded()})
    ORDER BY next_fetch_at NULLS FIRST LIMIT 40`;
  let enqueued = 0;
  for (const r of rows) {
    if (await enqueue(QUEUES.fetchSource, { sourceId: r.id }, { singletonKey: r.id })) enqueued += 1;
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id}`;
  }
  return { enqueued, shards: await scheduleXShards() };
}

/** Minutes between reads of a shard: editorial accounts every half hour, hot-signal accounts hourly. */
const X_SHARD_MINUTES: Record<string, number> = { editorial: 30, hot_signal: 60 };
const shardMinutes = (mode: string) => X_SHARD_MINUTES[mode] ?? 60;

/**
 * Daily: adapt each source's interval to its recent output (active 15 min … quiet 120 min).
 * hot_signal sources are allowed to be slower.
 */
export async function adaptIntervals(): Promise<{ updated: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode" | "kind" | "config" | "cursor"> & { paid_listing: boolean; per_day: number }>>`
    SELECT s.id, s.participation_mode, s.kind, s.config, s.cursor, coalesce(s.config->>'url', '') LIKE 'https://r.jina.ai/%' AS paid_listing,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list', 'x_search')`;
  let updated = 0;
  for (const r of rows) {
    const perDay = Number(r.per_day);
    // Editorial sites and feeds are looked at hourly at least (they cost nothing);
    // editorial X and listings read through Jina stop at two hours (paid per call, within their budgets);
    // hot signals may wait longer.
    const max = r.participation_mode === "hot_signal" ? 180 : r.kind === "x_search" || r.paid_listing ? 120 : 60;
    // Listings read through Jina are not looked at more than hourly: busy ones would outrun its daily budget.
    const min = r.paid_listing ? 60 : 15;
    // X accounts read by shard follow the shard's pace, whatever their own volume.
    const target = shardHandle(r) ? shardMinutes(r.participation_mode) : perDay <= 0.15 ? max : Math.round(Math.min(max, Math.max(min, (24 * 60) / (perDay * 3))));
    const res = await sql`UPDATE sources SET interval_minutes = ${target} WHERE id = ${r.id} AND interval_minutes <> ${target}`;
    updated += res.count;
  }
  return { updated };
}
