// v1 items and the selected sync (snapshot + changes), read from the same public read layer.
import type { PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { sql, type Db } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { newShortId } from "../lib/ids.ts";
import { publicCategoryCondition, API_ITEM_COLUMNS, API_ITEM_FROM, type ApiItemRow } from "./items.ts";
import { listedCondition, seatedCondition } from "./scope.ts";
import { publicMatchCondition, searchTerms, withSearchCapacity } from "./pool.ts";
import { cachedByKey, SHARED_ONLY } from "../lib/cache.ts";
import { v1Payload, type V1ItemPayload } from "./publish.ts";

export interface V1ItemsQuery {
  mode: "selected" | "all";
  window: "24h" | "7d";
  by: "timeline" | "published";
  category: PublicApiCategoryKey | null;
  q: string | null;
  limit: number;
  cursor: string | null;
}

export interface V1ItemsResult {
  schemaVersion: 1;
  query: { mode: string; category: string | null; window: string; q: string | null; by: string; ordering: string };
  items: V1ItemPayload[];
  page: { count: number; hasMore: boolean; nextCursor: string | null };
}

export function rowToV1(row: ApiItemRow): V1ItemPayload {
  return v1Payload({
    articleId: row.id, title: row.title, originalTitle: row.original_title, summary: row.summary, sourceName: row.source_name,
    url: row.url, publishedAt: row.published_at, discoveredAt: row.discovered_at, category: row.category,
    score: row.score === null ? null : Number(row.score), selected: row.selected, reason: row.reason,
  });
}

const sharedSearch = cachedByKey(
  (q: V1ItemsQuery) => JSON.stringify([q.mode, q.window, q.by, q.category, q.q, q.limit, q.cursor]),
  (q) => queryItems(q, new Date()), { ...SHARED_ONLY, maxKeys: 200 },
);

/** Search callers across HTTP and tools share unfinished work, with no retained results. */
export function v1Items(query: V1ItemsQuery, now?: Date): Promise<V1ItemsResult> {
  return query.q?.trim() && !now ? sharedSearch(query) : queryItems(query, now ?? new Date());
}

async function queryItems(query: V1ItemsQuery, now: Date): Promise<V1ItemsResult> {
  const windowMs = query.window === "24h" ? 86400000 : 7 * 86400000;
  const windowStart = new Date(now.getTime() - windowMs);
  const binding = queryBinding({ m: query.mode, w: query.window, b: query.by, c: query.category, q: query.q });
  // by=timeline is the site's own order: a selected item at its reading-group anchor, anything else at its timeline time.
  const sortCol = query.by === "published" ? sql`coalesce(p.published_at, p.discovered_at)` : query.mode === "selected" ? sql`p.sort_at` : sql`p.timeline_at`;
  let after: { a: number; i: string } | null = null;
  if (query.cursor) {
    const c = decodeCursor<{ a: number; i: string; c: string }>("it3", query.cursor);
    if (c.c !== binding || !Number.isSafeInteger(c.a) || !Number.isFinite(new Date(c.a).getTime())
      || typeof c.i !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.i)) throw new InvalidCursorError("cursor does not belong to this query");
    // The rolling window slid past the anchor: tell the client instead of returning an empty page.
    if (c.a < windowStart.getTime()) throw new InvalidCursorError("the rolling window moved past this cursor");
    after = { a: c.a, i: c.i };
  }
  const scope = query.mode === "selected" ? seatedCondition(now) : listedCondition(now);
  const terms = query.q ? searchTerms(query.q) : [];

  const run = (db: Db) => db<(ApiItemRow & { sort_at: Date })[]>`
    SELECT ${API_ITEM_COLUMNS}, ${sortCol} AS sort_at ${API_ITEM_FROM}
    WHERE ${scope} ${publicCategoryCondition(query.category)} ${publicMatchCondition(terms)}
      AND ${sortCol} >= ${windowStart} AND ${sortCol} <= ${now}
      ${after ? sql`AND (${sortCol}, p.article_id) < (${new Date(after.a)}, ${after.i})` : sql``}
    ORDER BY ${sortCol} DESC, p.article_id DESC
    LIMIT ${query.limit + 1}`;
  const rows = terms.length ? await withSearchCapacity(run) : await run(sql);

  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  const last = page[page.length - 1];
  return {
    schemaVersion: 1,
    query: {
      mode: query.mode, category: query.category, window: query.window, q: query.q, by: query.by,
      ordering: query.by === "published" ? "publishedAtDesc" : "timelineDesc",
    },
    items: page.map(rowToV1),
    page: {
      count: page.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor("it3", { a: last.sort_at.getTime(), i: last.id, c: binding }) : null,
    },
  };
}

// Selected sync

export class SnapshotRequiredError extends Error {}

const SYNC_PREFIX = "ax1"; // any other watermark answers 409

const isWatermark = (value: number) => Number.isSafeInteger(value) && value >= 0;

let epochCache: string | null = null;

/** Ledger epoch: changes whenever the ledger is rebuilt (e.g. after an import), invalidating old watermarks. */
export async function ledgerEpoch(): Promise<string> {
  if (epochCache) return epochCache;
  const [row] = await sql<{ value: { epoch: string } }[]>`SELECT value FROM settings WHERE key = 'selected_ledger_epoch'`;
  if (row) return (epochCache = row.value.epoch);
  const epoch = newShortId(6);
  await sql`INSERT INTO settings (key, value) VALUES ('selected_ledger_epoch', ${sql.json({ epoch })}) ON CONFLICT (key) DO NOTHING`;
  const [again] = await sql<{ value: { epoch: string } }[]>`SELECT value FROM settings WHERE key = 'selected_ledger_epoch'`;
  return (epochCache = again!.value.epoch);
}

/** The ledger's latest sequence: a snapshot and a page of changes read up to it. */
export async function ledgerWatermark(): Promise<number> {
  const [row] = await sql<{ w: number }[]>`SELECT coalesce(max(seq), 0) AS w FROM selected_ledger`;
  return Number(row?.w ?? 0);
}

function minimalOf(item: V1ItemPayload) {
  return {
    id: item.id, title: item.title, source: item.source, publishedAt: item.publishedAt, discoveredAt: item.discoveredAt,
    category: item.category, score: item.score, selected: item.selected, links: { aihot: item.links.aihot },
  };
}

// Drop unused wide fields before crossing the database connection; minimalOf remains the output
// whitelist, preserving its omission of absent keys and all existing null values.
function ledgerPayload(minimal: boolean, payload = sql`payload`) {
  return minimal ? sql`(${payload} - ARRAY['originalTitle', 'summary', 'reason', 'attribution']::text[]) #- '{links,original}'` : payload;
}

export interface SnapshotQuery {
  fields?: "default" | "minimal";
  limit: number;
  page: string | null;
}

export async function selectedSnapshot(q: SnapshotQuery, now = new Date()) {
  const epoch = await ledgerEpoch();
  let fields = q.fields ?? "default";
  let w: number;
  let afterId = "";
  let asOf: string;
  if (q.page !== null) {
    // A page token that is broken, empty or from another snapshot (a rebuilt ledger) cannot continue
    // this snapshot: the client starts it over (409 snapshot_required).
    let p: { k: string; e: string; w: number; f: string; a: string; t: string };
    try {
      p = decodeCursor(SYNC_PREFIX, q.page);
    } catch {
      throw new SnapshotRequiredError("unreadable snapshot page token");
    }
    if (p.k !== "page" || p.e !== epoch || (p.f !== "default" && p.f !== "minimal") || !isWatermark(p.w)
      || typeof p.a !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.a)
      || typeof p.t !== "string" || !Number.isFinite(Date.parse(p.t))) {
      throw new SnapshotRequiredError("page token does not match this snapshot");
    }
    // Tokens are opaque, not signed: a supplied watermark must not be ahead of the ledger.
    if (p.w > await ledgerWatermark()) throw new SnapshotRequiredError("page watermark is ahead of this ledger");
    // A readable token asked for with another projection is the request's mistake, not a lost snapshot.
    if (q.fields !== undefined && p.f !== q.fields) throw new InvalidCursorError("page token belongs to another projection");
    // Only the first page defaults to full fields; continuations inherit their original projection.
    fields = p.f;
    w = p.w;
    afterId = p.a;
    asOf = p.t;
  } else {
    w = await ledgerWatermark();
    asOf = now.toISOString();
  }
  // The set as of the watermark, less anything taken out of the selected set since (a withdrawal while
  // the client pages through the snapshot). Its remove still follows in changes, which the client
  // applies as a no-op.
  const rows = await sql<{ article_id: string; payload: V1ItemPayload }[]>`
    SELECT latest.article_id, ${ledgerPayload(fields === "minimal", sql`latest.payload`)} AS payload FROM (
      SELECT DISTINCT ON (article_id) article_id, op, payload FROM selected_ledger
      WHERE seq <= ${w} AND article_id > ${afterId}
      ORDER BY article_id, seq DESC
    ) latest
    JOIN selected_state st ON st.article_id = latest.article_id AND st.in_set
    WHERE latest.op = 'upsert'
    ORDER BY latest.article_id
    LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const hasMore = rows.length > q.limit;
  const last = page[page.length - 1];
  return {
    schemaVersion: 1 as const,
    asOf,
    fields,
    cursor: encodeCursor(SYNC_PREFIX, { k: "sync", e: epoch, w, f: fields }),
    count: page.length,
    hasMore,
    nextPage: hasMore && last ? encodeCursor(SYNC_PREFIX, { k: "page", e: epoch, w, f: fields, a: last.article_id, t: asOf }) : null,
    items: page.map((r) => (fields === "minimal" ? minimalOf(r.payload) : r.payload)),
  };
}

export async function selectedChanges(q: { cursor: string; limit: number }, now = new Date()) {
  const epoch = await ledgerEpoch();
  let c: { k: string; e: string; w: number; f: "default" | "minimal" };
  try {
    c = decodeCursor(SYNC_PREFIX, q.cursor);
  } catch {
    throw new SnapshotRequiredError("unknown watermark");
  }
  if (c.k !== "sync" || c.e !== epoch || !isWatermark(c.w) || (c.f !== "default" && c.f !== "minimal")) {
    throw new SnapshotRequiredError("watermark from another ledger epoch or format");
  }
  const w = await ledgerWatermark();
  if (c.w > w) throw new SnapshotRequiredError("watermark is ahead of this ledger");
  // An offline client's old watermark must not redistribute content withdrawn since the upsert.
  // Keep every sequence (as a removal) so even a one-entry page advances without exposing it.
  const rows = await sql<{ seq: number; article_id: string; op: "upsert" | "remove"; changed_at: Date; payload: V1ItemPayload | null }[]>`
    SELECT l.seq, l.article_id, CASE WHEN p.article_id IS NULL THEN 'remove' ELSE l.op END AS op, l.changed_at,
      CASE WHEN p.article_id IS NOT NULL THEN ${ledgerPayload(c.f === "minimal", sql`l.payload`)} END AS payload
    FROM selected_ledger l LEFT JOIN publications p ON p.article_id = l.article_id AND ${listedCondition(now)}
    WHERE l.seq > ${c.w} AND l.seq <= ${w}
    ORDER BY l.seq LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const hasMore = rows.length > q.limit;
  const nextW = page.length ? page[page.length - 1]!.seq : Math.max(c.w, 0);
  return {
    schemaVersion: 1 as const,
    fields: c.f,
    cursor: encodeCursor(SYNC_PREFIX, { k: "sync", e: epoch, w: nextW, f: c.f }),
    count: page.length,
    hasMore,
    changes: page.map((r) =>
      r.op === "remove"
        ? { op: "remove" as const, changedAt: r.changed_at.toISOString(), id: r.article_id }
        : { op: "upsert" as const, changedAt: r.changed_at.toISOString(), item: c.f === "minimal" ? minimalOf(r.payload!) : r.payload! },
    ),
  };
}
