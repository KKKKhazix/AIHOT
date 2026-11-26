// Public pool (/all) with numeric pages, and search in its two orderings.
import { ENGLISH } from "@aihot/contracts/english";
import type { PoolResponse, TimelineFilters } from "@aihot/contracts/site";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { one, sql, withCustomPlans, type Db } from "../db.ts";
import { cachedByKey, sharedSearch } from "../lib/cache.ts";
import {
  categoryCondition, channelCondition, ITEM_COLUMNS, ITEM_FROM, seatHolders, tagCondition, toFeedItemSummary,
  type ItemRow,
} from "./items.ts";
import { usableCopy } from "./english.ts";
import { browsedCondition, listedCondition } from "./scope.ts";
import { tagTopics, TOPICS } from "./topics.ts";

export const POOL_PAGE_SIZE = 40;
export const POOL_MAX_PAGES = 50;

export class SearchBusyError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super("search capacity exhausted");
    this.retryAfter = retryAfter;
  }
}

// Search capacity guard: bounded concurrency with a short queue. Overflow answers 503 + Retry-After
// instead of letting machine traffic drag list browsing down.
const MAX_CONCURRENT_SEARCHES = 4;
const MAX_QUEUED_SEARCHES = 8;
let running = 0;
const waiters: Array<() => void> = [];

export async function withSearchCapacity<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_SEARCHES) {
    if (waiters.length >= MAX_QUEUED_SEARCHES) throw new SearchBusyError(5);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        reject(new SearchBusyError(5));
      }, 3000);
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(go);
    });
  }
  running += 1;
  try {
    return await withCustomPlans(fn);
  } finally {
    running -= 1;
    waiters.shift()?.();
  }
}

/** Search terms: whitespace separated, lower-cased, LIKE metacharacters escaped. */
export function searchTerms(q: string): string[] {
  return q
    .toLowerCase()
    // "多模态RAG" means 多模态 and rag: split where Han meets a Latin word. Digits alone stay attached,
    // so "10月" is still one term rather than 10 and 月.
    .replace(/(\p{Script=Han})(?=[a-z])/gu, "$1 ")
    .replace(/([a-z][a-z0-9]*)(?=\p{Script=Han})/gu, "$1 ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/[\\%_]/g, (m) => `\\${m}`));
}

// Join only translations of current public-facing titles and summaries. A withdrawn original
// invalidates its translation for search on the same read as it does on the article page.
function translatedSearch(terms: string[]) {
  if (!ENGLISH || !terms.length) return null;
  return sql`matching_copy AS MATERIALIZED (
    SELECT c.zh, lower(c.en) AS en FROM english_copy c
    WHERE lower(c.en) LIKE ANY(${terms.map(t => "%" + t + "%")}::text[]) AND ${usableCopy}
  ), translated AS MATERIALIZED (
    SELECT p.article_id, c.en, true AS headline FROM matching_copy c JOIN publications p ON p.title = c.zh WHERE p.eligible OR p.selected
    UNION ALL
    SELECT p.article_id, c.en, false FROM matching_copy c JOIN publications p ON p.summary = c.zh WHERE p.eligible OR p.selected
  )`;
}
type Copies = ReturnType<typeof translatedSearch>;
const like = (col: ReturnType<typeof sql>, t: string) => sql`${col} LIKE ${"%" + t + "%"}`;
function textMatch(col: ReturnType<typeof sql>, id: ReturnType<typeof sql>, t: string, copies: Copies, titleOnly = false) {
  const direct = like(col, t);
  return copies ? sql`(${direct} OR ${id} IN (SELECT article_id FROM translated WHERE ${like(sql`en`, t)} ${titleOnly ? sql`AND headline` : sql``}))` : direct;
}

const normalizeAlias = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The company a whole query names: a company topic's slug, full name,
 * each part of "OpenAI / ChatGPT" and its other names. Then the search also takes the articles about
 * that company (their subject tag), so "claude" finds Anthropic's news that never writes the word.
 * Only the whole query counts: "deepseek v4" stays a text search, not all of DeepSeek.
 */
function queryEntityTag(q: string): string | null {
  const want = normalizeAlias(q);
  if (!want) return null;
  const topic = TOPICS.find((t) => t.entityId && t.aliases.some((a) => normalizeAlias(a) === want));
  return topic ? `entity:${topic.entityId}` : null;
}

/**
 * A plain Latin or digit term must start a word in the body: "rag" is not inside "storage".
 */
function bodyMatch(t: string) {
  const like = sql`ps.body LIKE ${"%" + t + "%"}`;
  return /^[a-z0-9]+$/.test(t) ? sql`${like} AND ps.body ~ ${"(^|[^a-z0-9])" + t}` : like;
}

/** Match each term against a recent public item, its readable body and the translations it uses. */
export function publicMatchCondition(terms: string[]) {
  // Keep the lookups on each time-ordered candidate's keys. Materializing global matches
  // before paging makes a broad term scan the archive even for one page of recent items.
  return terms.reduce((acc, term) => {
    const translation = ENGLISH ? sql`OR EXISTS (
      SELECT 1 FROM english_copy c
      WHERE c.zh_hash IN (encode(sha256(convert_to(p.title, 'UTF8')), 'hex'), encode(sha256(convert_to(p.summary, 'UTF8')), 'hex'))
        AND c.zh IN (p.title, p.summary) AND ${like(sql`lower(c.en)`, term)} AND ${usableCopy} OFFSET 0)` : sql``;
    return sql`${acc} AND (${like(sql`p.search_text`, term)} OR EXISTS (
      SELECT 1 FROM pool_search ps WHERE ps.article_id = p.article_id AND ${bodyMatch(term)} OFFSET 0)
      ${translation})`;
  }, sql``);
}

/** The listed items under the filters, up to the pages the pool offers. */
async function listedCount(f: TimelineFilters, now: Date): Promise<number> {
  return Number(one(await sql<{ n: number }[]>`
    SELECT count(*) AS n FROM (SELECT 1 FROM publications p WHERE ${browsedCondition(now)}
      ${channelCondition(f.channel)} ${categoryCondition(f.category)} ${tagCondition(f.tag)} LIMIT ${POOL_MAX_PAGES * POOL_PAGE_SIZE}) t`).n);
}

/** Without a search the total only sets the page count: it is reused for 30 seconds per filter. */
const poolTotal = cachedByKey((f: TimelineFilters) => JSON.stringify([f.channel, f.category, f.tag]), (f) => listedCount(f, new Date()), { freshMs: 30_000, maxStaleMs: 30_000, maxKeys: 200 });

export interface PoolQuery extends TimelineFilters {
  q?: string | null;
  tab?: "time" | "relevance";
  page?: number;
  now?: Date;
}

// Identical searches share their read before taking search capacity.
const searchPool = sharedSearch(
  (q: PoolQuery) => JSON.stringify([q.channel, q.category, q.tag, q.q, q.tab, q.page]),
  queryPool, (q) => !!q.q?.trim(),
);

export function loadPool(query: PoolQuery): Promise<PoolResponse> {
  return searchPool(query, query.now);
}

async function queryPool(query: PoolQuery, now: Date): Promise<PoolResponse> {
  const page = Math.min(Math.max(query.page ?? 1, 1), POOL_MAX_PAGES);
  const q = query.q?.trim() || null;
  const tab = q && query.tab === "relevance" ? "relevance" : "time";
  const terms = q ? searchTerms(q) : [];
  const copies = translatedSearch(terms);
  const withCopies = copies ? sql`WITH ${copies},` : sql`WITH`;
  const entityTag = q ? queryEntityTag(q) : null;
  const filters = sql`${channelCondition(query.channel)} ${categoryCondition(query.category)} ${tagCondition(query.tag)}`;
  const offset = (page - 1) * POOL_PAGE_SIZE;
  const cap = POOL_MAX_PAGES * POOL_PAGE_SIZE;

  // Searches go through pool_search (eligible items only): trigram indexes for longer terms, a small
  // table to scan for one- and two-character ones.
  const directConditions = (col: ReturnType<typeof sql>, id: ReturnType<typeof sql>) =>
    terms.reduce((acc, t) => sql`${acc} AND ${textMatch(col, id, t, copies)}`, sql``);
  const matchOrSubject = (text: ReturnType<typeof directConditions>) => (entityTag ? sql`AND (p.tags @> ${[entityTag]}::text[] OR (TRUE ${text}))` : text);
  const run = async (db: Db) => {
    if (!q) {
      // Page ids from the timeline index first, then the joins for those rows only.
      const rows = await db<ItemRow[]>`
        WITH page AS (
          SELECT p.article_id FROM publications p WHERE ${browsedCondition(now)} ${filters}
          ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
        SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
        ORDER BY p.timeline_at DESC, p.article_id DESC`;
      // A fixed clock (tests, replays) never shares cached totals.
      return { rows, total: query.now ? await listedCount(query, now) : await poolTotal(query) };
    }
    type CountedRow = Omit<ItemRow, "id"> & { id: string | null; total: number };
    const pageResult = (result: CountedRow[]) => ({
      rows: result.filter((r): r is ItemRow & { total: number } => r.id !== null),
      total: Number(one(result).total),
    });
    if (tab === "relevance") {
      // Rank narrow rows first: no article bodies or translations enter the sort/count. The public
      // total stops at 2,000, even though ranking must consider every matching item.
      // For an unfiltered trigram search, match each indexed field separately. OR across fields
      // can make PostgreSQL scan every toasted body instead. Keep other searches inline so short
      // terms, additional terms and selective publication filters retain their existing plans.
      const splitFields = terms.length === 1 && /[\p{L}\p{N}]{3}/u.test(terms[0]!)
        && (!query.channel || query.channel === "all") && !query.category && !query.tag;
      const directMatch = (t: string) => textMatch(sql`ps.direct`, sql`ps.article_id`, t, copies);
      const partScore = terms.reduce(
        (acc, t) => sql`${acc} + (CASE WHEN ${directMatch(t)} THEN 3 ELSE 0 END) + (CASE WHEN ${like(sql`ps.body`, t)} THEN 1 ELSE 0 END)`,
        sql`0`,
      );
      const titleScore = terms.reduce((acc, t) => sql`${acc} + (CASE WHEN ${textMatch(sql`lower(p.title)`, sql`p.article_id`, t, copies, true)} THEN 6 ELSE 0 END)`, sql`0`);
      const anyMatch = terms.reduce((acc, t) => sql`${acc} AND (${directMatch(t)} OR ${like(sql`ps.body`, t)})`, sql`TRUE`);
      const matches = splitFields ? sql`
        SELECT coalesce(d.article_id, b.article_id) AS article_id,
          (CASE WHEN d.article_id IS NOT NULL THEN 3 ELSE 0 END) + (CASE WHEN b.article_id IS NOT NULL THEN 1 ELSE 0 END) AS part
        FROM (SELECT article_id FROM pool_search WHERE direct LIKE ${"%" + terms[0]! + "%"}
          ${copies ? sql`UNION SELECT article_id FROM translated` : sql``}) d
        FULL JOIN (SELECT article_id FROM pool_search WHERE body LIKE ${"%" + terms[0]! + "%"}) b ON b.article_id = d.article_id`
        : sql`SELECT ps.article_id, (${partScore}) AS part FROM pool_search ps WHERE ${anyMatch}`;
      // Equal relevance: a seated selected item first, then the higher quality score, then the newest.
      const tie = sql`(CASE WHEN p.selected AND p.seat THEN 1000 ELSE 0 END) + coalesce(p.score, 0)`;
      // A query naming a company also takes the articles about it, ranked first.
      const scored = entityTag ? sql`
          SELECT p.article_id, p.timeline_at, max(matches.part) + (${titleScore}) + (CASE WHEN p.tags @> ${[entityTag]}::text[] THEN 10 ELSE 0 END) AS rel, ${tie} AS tie
          FROM (SELECT article_id, part FROM matches UNION ALL SELECT article_id, 0 FROM publications WHERE tags @> ${[entityTag]}::text[]) matches
          JOIN publications p ON p.article_id = matches.article_id
          WHERE ${listedCondition(now)} ${filters}
          GROUP BY p.article_id, p.timeline_at, p.title, p.tags, p.selected, p.seat, p.score` : sql`
          SELECT p.article_id, p.timeline_at, matches.part + (${titleScore}) AS rel, ${tie} AS tie
          FROM matches JOIN publications p ON p.article_id = matches.article_id JOIN sources s ON s.id = p.source_id
          WHERE ${listedCondition(now)} ${filters}`;
      const result = await db<CountedRow[]>`
        ${withCopies} matches AS ${splitFields ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (${matches}), scored AS MATERIALIZED (${scored}
        ), page AS MATERIALIZED (
          SELECT article_id, rel, tie FROM scored ORDER BY rel DESC, tie DESC, timeline_at DESC, article_id DESC
          LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset}
        ), total AS (SELECT count(*) AS n FROM (SELECT 1 FROM scored LIMIT ${cap}) capped)
        SELECT hydrated.*, total.n AS total FROM total LEFT JOIN LATERAL (
          SELECT ${ITEM_COLUMNS}, page.rel, page.tie ${ITEM_FROM} JOIN page ON page.article_id = p.article_id
        ) hydrated ON true ORDER BY hydrated.rel DESC, hydrated.tie DESC, hydrated.timeline_at DESC, hydrated.id DESC`;
      return pageResult(result);
    }
    // Default search: newest first straight from the timeline index; the total from the pool's
    // search rows, where one- and two-character terms scan a small table instead of every item.
    const direct = directConditions(sql`ps.direct`, sql`ps.article_id`);
    const result = await db<CountedRow[]>`
      ${withCopies} page AS (
        SELECT p.article_id FROM publications p WHERE ${listedCondition(now)} ${filters} ${matchOrSubject(directConditions(sql`p.search_text`, sql`p.article_id`))}
        ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset}
      ), total AS (
        SELECT count(*) AS n FROM (SELECT 1 FROM pool_search ps JOIN publications p ON p.article_id = ps.article_id
          WHERE ${listedCondition(now)} ${filters} ${matchOrSubject(direct)} LIMIT ${cap}) t
      )
      SELECT hydrated.*, total.n AS total FROM total LEFT JOIN LATERAL (
        SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
      ) hydrated ON true ORDER BY hydrated.timeline_at DESC, hydrated.id DESC`;
    return pageResult(result);
  };

  const { rows, total } = q ? await withSearchCapacity(run) : await run(sql);
  const today = beijingDate(now);
  const meta = one(await sql<{ today_count: number; updated_at: Date | null }[]>`
    SELECT (SELECT count(*) FROM publications p
      WHERE ${browsedCondition(now)} AND p.timeline_at >= ${beijingMidnight(today)} ${filters}) AS today_count,
      (SELECT max(p.updated_at) FROM publications p WHERE p.eligible) AS updated_at`);

  const holders = await seatHolders(rows, now);
  const items = rows.map((r) => (holders.has(r.id) ? { ...toFeedItemSummary(r), reason: null, sameEvent: holders.get(r.id)! } : toFeedItemSummary(r)));
  return {
    filters: { channel: query.channel, category: query.category, tag: query.tag, q, tab },
    items,
    tagTopics: tagTopics([...new Set(items.flatMap((i) => i.tags))]),
    page,
    pageCount: Math.min(POOL_MAX_PAGES, Math.max(1, Math.ceil(total / POOL_PAGE_SIZE))),
    total,
    todayCount: Number(meta.today_count),
    freshness: (meta.updated_at ?? now).toISOString(),
  };
}
