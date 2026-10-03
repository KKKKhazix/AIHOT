// Topics: stable slugs in three groups (companies, directions, content forms), defined by the industry
// pack (industry/topics.json) and read from there when the process starts. Which reports a topic takes
// is one SQL predicate, `membership`: a direction or a form takes its tags; a company takes the reports
// it is a subject of, but not those that only mention it — among several subject companies, its name must
// appear in the Chinese or the original title. Lists, counts and the chronicle read the selected set
// one report per fact, as v1 and RSS do.
import type { LbBrand } from "@aihot/contracts/leaderboard";
import type { CategoryKey } from "@aihot/contracts/taxonomy";
import type {
  TopicGroup, TopicGroupKey, TopicLink, TopicPage, TopicSummary, TopicsResponse,
} from "@aihot/contracts/site";
import { FEATURES } from "@aihot/industry/features";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { ENTITIES } from "../editorial/vocabulary.ts";
import { providerMark } from "../leaderboard/read.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { companyMilestones, curatedChronicle } from "./chronicles.ts";
import { CHRONICLE_KINDS, chronicleReadReports, selectTopicChronicle, selectTopicHighlights, type ChronicleReport } from "./topic-chronicle.ts";
import { factSources } from "./coverage.ts";
import { ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary, type ItemRow } from "./items.ts";
import { evidenceCondition, listedCondition, ownFactEvidenceCondition, seatedCondition, selectedCondition, storyReportCondition } from "./scope.ts";

export interface Topic {
  slug: string;
  name: string;
  group: TopicGroupKey;
  definition: string;
  /** Companies: the subject id (industry/taxonomy.ts ENTITIES). */
  entityId: string | null;
  /** Companies: the provider slug of its models on the leaderboard. */
  provider: string | null;
  /** Tags that put a report in the topic: a company's subject tag, a direction's or a form's tags. */
  tags: string[];
  /** Companies: a title naming the company by any of its names (a PostgreSQL regular expression). */
  pattern: string | null;
  /** Companies: what a whole search query may call it. */
  aliases: string[];
  /** Directions: a milestone's title uses one of these words (topic-chronicle.ts). */
  terms: RegExp | null;
  /** Companies: the names its own announcements open with, left out of its chronicle's labels. */
  orgNames: string[];
}

interface TopicFile {
  groups: TopicGroup[];
  topics: Array<{ slug: string; name: string; group: TopicGroupKey; entityId?: string; leaderboardProvider?: string; aliases?: string[]; tags?: string[]; chronicleTerms?: string[]; orgNames?: string[]; definition: string }>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameParts = (name: string) => name.split("/").map((s) => s.trim()).filter(Boolean);

/** Any name of the company: the topic's name and its parts, the subject's names. Latin names match as whole words. */
function titlePattern(name: string, entityId: string): string {
  const e = ENTITIES[entityId];
  const names = new Set([name, ...nameParts(name), ...(e ? [e.name, ...e.aliases, ...(e.otherNames ?? [])] : [])]);
  return `(?<![A-Za-z])(${[...names].map(escape).join("|")})(?![A-Za-z])`;
}

/** Any of the words, a Latin one at the start of a word, and a whole word when it has three letters or fewer. */
function termPattern(words: string[]): RegExp {
  const part = (w: string) => !/^[A-Za-z]/.test(w) ? escape(w) : `(?<![A-Za-z])${escape(w)}${w.length <= 3 ? "(?![A-Za-z])" : ""}`;
  return new RegExp(words.map(part).join("|"), "i");
}

const file = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as TopicFile;

export const TOPIC_GROUPS: TopicGroup[] = file.groups;

export const TOPICS: Topic[] = file.topics.map((t) => ({
  slug: t.slug,
  name: t.name,
  group: t.group,
  definition: t.definition,
  entityId: t.entityId ?? null,
  provider: t.leaderboardProvider ?? null,
  tags: t.entityId ? [`entity:${t.entityId}`] : (t.tags ?? []),
  pattern: t.entityId ? titlePattern(t.name, t.entityId) : null,
  aliases: t.entityId ? [t.slug, t.name, ...nameParts(t.name), ...(t.aliases ?? [])] : [],
  terms: t.chronicleTerms?.length ? termPattern(t.chronicleTerms) : null,
  orgNames: t.orgNames ?? [],
}));

const BY_SLUG = new Map(TOPICS.map((t, position) => [t.slug, { topic: t, position }]));

export function findTopic(slug: string): Topic | null {
  return BY_SLUG.get(slug)?.topic ?? null;
}

const position = (slug: string) => BY_SLUG.get(slug)?.position ?? Number.MAX_SAFE_INTEGER;

export function topicLinks(slugs: string[]): TopicLink[] {
  return slugs.map((s) => findTopic(s)).filter((t): t is Topic => !!t).map((t) => ({ slug: t.slug, name: t.name }));
}

/**
 * The topics report `p` belongs to, in topic order: its tags meet the topic's and, for a company, the
 * title names it or it is the report's only subject company.
 */
export function topicMembership(topics: Topic[] = TOPICS) {
  const rows = topics.map((t) => ({ slug: t.slug, tags: t.tags, pattern: t.pattern, position: position(t.slug) }));
  return sql`ARRAY(
    SELECT t.slug FROM jsonb_to_recordset(${sql.json(rows)}::jsonb) AS t(slug text, tags text[], pattern text, position int)
    WHERE p.tags && t.tags AND (t.pattern IS NULL OR p.title ~* t.pattern OR coalesce(p.original_title, '') ~* t.pattern
      OR (SELECT count(*) FROM unnest(p.tags) AS e(tag) WHERE e.tag LIKE 'entity:%') = 1)
    ORDER BY t.position)`;
}

/** Report `p` is in topic `t`; the tag overlap comes first, for the tags index. */
function inTopic(t: Topic) {
  return sql`p.tags && ${t.tags}::text[] AND ${t.slug} = ANY(${topicMembership([t])})`;
}

// ---------------------------------------------------------------------------------------------------
// The selected set by topic, read in one pass and kept a minute (counts may lag by that much; the
// rows of a page are checked again when read).

interface Seat extends Omit<ChronicleReport, "timelineAt" | "topicSlugs" | "storyPublicId" | "sourceCount"> {
  at: Date;
  /** When the selected report became visible. */
  released: Date;
  story: string | null;
  topics: string[];
}

interface SeatRow {
  id: string;
  at: Date;
  released: Date;
  title: string;
  original_title: string | null;
  published_at: Date | null;
  fact_published_at: Date | null;
  tags: string[];
  score: number | null;
  first_party: boolean;
  category: CategoryKey | null;
  owner: string | null;
  fact_id: number | null;
  fact_subject: string | null;
  fact_action: string | null;
  fact_occurred_at: Date | null;
  scope: string | null;
  story: string | null;
  topics: string[];
}

interface TopicIndex {
  at: Date;
  /** Each topic's reports, newest first. */
  bySlug: Map<string, Seat[]>;
  /** Editorial sources that reported each fact. */
  sources: Map<number, number>;
}

/** The full index or a bounded set of its candidates, with their current content and membership. */
async function readSeats(now: Date, ids?: string[], topics: Topic[] = TOPICS): Promise<Seat[]> {
  const rows = await sql<SeatRow[]>`
    WITH seats AS (
      SELECT p.article_id AS id, p.timeline_at AS at, p.visible_after AS released, p.title, p.score, (s.tier = 'T1') AS first_party,
        p.category, p.original_title, p.published_at, p.tags, s.owner_entity_id AS owner, p.fact_id,
        f.subject AS fact_subject, f.action AS fact_action, f.occurred_at AS fact_occurred_at, a.output->>'scope' AS scope,
        st.public_id::text AS story, ${topicMembership(topics)} AS topics
      FROM publications p JOIN sources s ON s.id = p.source_id
      LEFT JOIN facts f ON f.id = p.fact_id
      LEFT JOIN analyses a ON a.id = p.analysis_id
      LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
      WHERE ${seatedCondition(now)}
        ${ids ? sql`AND p.article_id = ANY(${[...new Set(ids)]}::text[])` : sql``}
    ), dates AS (
      SELECT p.fact_id, min(coalesce(p.published_at, p.timeline_at)) AS fact_published_at
      FROM publications p WHERE p.fact_id IN (SELECT fact_id FROM seats WHERE fact_id IS NOT NULL)
        AND ${selectedCondition(now)} AND ${ownFactEvidenceCondition()}
      GROUP BY p.fact_id
    )
    SELECT seats.*, dates.fact_published_at FROM seats LEFT JOIN dates ON dates.fact_id = seats.fact_id
    ORDER BY seats.at DESC, seats.id DESC`;
  return rows.map((r) => ({
    id: r.id, at: r.at, released: r.released, title: r.title, score: r.score, firstParty: r.first_party, category: r.category, owner: r.owner,
    factId: r.fact_id, story: r.story, topics: r.topics, originalTitle: r.original_title, publishedAt: r.published_at, factPublishedAt: r.fact_published_at, tags: r.tags,
    factSubject: r.fact_subject, factAction: r.fact_action, factOccurredAt: r.fact_occurred_at, scope: r.scope,
  }));
}

async function readIndex(now: Date): Promise<TopicIndex> {
  const seats = await readSeats(now);
  const bySlug = new Map(TOPICS.map((t) => [t.slug, [] as Seat[]]));
  const facts = new Set<number>();
  for (const seat of seats) {
    if (seat.topics.length === 0) continue;
    for (const slug of seat.topics) bySlug.get(slug)?.push(seat);
    if (seat.factId !== null) facts.add(seat.factId);
  }
  const sources = new Map([...(await factSources([...facts], now))].map(([id, list]) => [id, list.length]));
  return { at: now, bySlug, sources };
}

const indexCache = cached(() => readIndex(new Date()), { freshMs: 60_000, maxStaleMs: 10 * 60_000 });

/** A given `now` reads afresh (tests, a clock other than this minute's). */
const topicIndex = (now?: Date) => (now ? readIndex(now) : indexCache.get());

const DAY = 86400_000;
const RECENT_DAYS = 30;
export const TOPIC_PAGE_SIZE = 20;

/**
 * Every company's mark: that of its best model on the leaderboard (when the site has one), or its
 * initial when it has none there.
 */
async function companyBrands(): Promise<Map<string, LbBrand>> {
  const companies = TOPICS.filter((t) => t.group === "company");
  const marks = await Promise.all(companies.map((t) => (FEATURES.leaderboard && t.provider ? providerMark(t.provider) : null)));
  return new Map(companies.map((t, i) => [t.slug, marks[i] ?? { src: null, monogram: t.name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase(), raster: false }]));
}

const recentCount = (seats: Seat[], now: Date) => seats.filter((s) => s.at.getTime() > now.getTime() - RECENT_DAYS * DAY).length;

/** Thin topics keep their page but stay out of the sitemap and search engines. */
const isIndexable = (total: number, recent: number) => total >= 50 || (total >= 20 && recent > 0);

/** Reports to look at for a topic's newest one, in case the newest was withdrawn since the index was read. */
const LATEST_CANDIDATES = 3;

/**
 * Recheck only the reports a page may name: withdrawals and corrections take effect even while
 * counts are cached, including the title, membership and fields that decide chronicle eligibility.
 */
async function currentSeats(ids: string[], now: Date, topics: Topic[] = TOPICS): Promise<Map<string, Seat>> {
  if (ids.length === 0) return new Map();
  return new Map((await readSeats(now, ids, topics)).map((s) => [s.id, s]));
}

function summarize(t: Topic, seats: Seat[], now: Date, brands: Map<string, LbBrand>, live: Map<string, Seat>): TopicSummary {
  const recent = recentCount(seats, now);
  const latest = seats.slice(0, LATEST_CANDIDATES).map((s) => live.get(s.id)).find((s) => s?.topics.includes(t.slug));
  return {
    slug: t.slug,
    name: t.name,
    group: t.group,
    definition: t.definition,
    brand: brands.get(t.slug) ?? null,
    total: seats.length,
    recent,
    indexable: isIndexable(seats.length, recent),
    latest: latest ? { title: latest.title, at: latest.at.toISOString() } : null,
  };
}

export async function listTopicSummaries(): Promise<TopicsResponse> {
  const [index, brands] = await Promise.all([topicIndex(), companyBrands()]);
  const live = await currentSeats(TOPICS.flatMap((t) => index.bySlug.get(t.slug)!.slice(0, LATEST_CANDIDATES).map((s) => s.id)), new Date());
  return { groups: TOPIC_GROUPS, topics: TOPICS.map((t) => summarize(t, index.bySlug.get(t.slug)!, index.at, brands, live)) };
}

export interface TopicCount {
  slug: string;
  pages: number;
  indexable: boolean;
  /** When a report last appeared in the topic. */
  changedAt: Date | null;
}

/** For the sitemap and IndexNow: every topic's pages and when they last changed. */
export async function topicPageCounts(): Promise<TopicCount[]> {
  const index = await topicIndex();
  return TOPICS.map((t) => {
    const seats = index.bySlug.get(t.slug)!;
    return {
      slug: t.slug,
      pages: Math.max(1, Math.ceil(seats.length / TOPIC_PAGE_SIZE)),
      indexable: isIndexable(seats.length, recentCount(seats, index.at)),
      changedAt: seats.reduce<Date | null>((m, s) => (!m || s.released > m ? s.released : m), null),
    };
  });
}

// ---------------------------------------------------------------------------------------------------
// Chronicle candidates use the same pure rules as historical replay. Keep cached index counts,
// but reread the bounded reports whose current fields can decide a displayed event.

function chronicleReport(s: Seat, sources: Map<number, number>): ChronicleReport {
  return { ...s, timelineAt: s.at, storyPublicId: s.story, topicSlugs: s.topics,
    sourceCount: s.factId === null ? 1 : Math.max(1, sources.get(s.factId) ?? 1) };
}

const poolCounts = new Map<string, Cached<number>>();

/** Every listed report of the topic, selected or not (收录). */
function poolTotal(t: Topic, now?: Date): Promise<number> {
  const read = async (at: Date) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications p WHERE ${listedCondition(at)} AND ${inTopic(t)}`)[0]?.n ?? 0;
  if (now) return read(now);
  let count = poolCounts.get(t.slug);
  if (!count) poolCounts.set(t.slug, (count = cached(() => read(new Date()), { freshMs: 60_000, maxStaleMs: 10 * 60_000 })));
  return count.get();
}

export async function loadTopicPage(slug: string, page: number, now?: Date): Promise<TopicPage | null> {
  const topic = findTopic(slug);
  if (!topic || !Number.isInteger(page) || page < 1) return null;
  const index = await topicIndex(now);
  const seats = index.bySlug.get(slug)!;
  const pageCount = Math.max(1, Math.ceil(seats.length / TOPIC_PAGE_SIZE));
  if (page > pageCount) return null;
  const ids = seats.slice((page - 1) * TOPIC_PAGE_SIZE, page * TOPIC_PAGE_SIZE).map((s) => s.id);
  const first = page === 1;
  const at = now ?? new Date();
  const history = first && topic.group === "company" ? curatedChronicle(topic.slug) : undefined;
  const window = { now: at, through: history?.through };
  const named = first ? chronicleReadReports(seats.map((s) => chronicleReport(s, index.sources)), window) : [];
  const [rows, pool, brands, live] = await Promise.all([
    ids.length
      ? sql<ItemRow[]>`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id = ANY(${ids}::text[]) AND ${seatedCondition(at)} AND ${inTopic(topic)}
          ORDER BY p.timeline_at DESC, p.article_id DESC`
      : [],
    poolTotal(topic, now),
    companyBrands(),
    currentSeats([...seats.slice(0, LATEST_CANDIDATES), ...named].map((s) => s.id), at, [topic]),
  ]);
  const shown = named.flatMap((s) => {
    const current = live.get(s.id);
    return current?.topics.includes(slug) ? [chronicleReport(current, index.sources)] : [];
  });
  const groupName = TOPIC_GROUPS.find((g) => g.key === topic.group)?.name ?? "";
  const picked = first ? selectTopicChronicle(topic, shown, window) : [];
  return {
    topic: { ...summarize(topic, seats, index.at, brands, live), groupName, poolTotal: pool },
    kinds: CHRONICLE_KINDS,
    chronicle: first && topic.group !== "company" ? picked : [],
    milestones: first && topic.group === "company" ? companyMilestones(history, picked) : [],
    highlights: first ? selectTopicHighlights(topic, shown, window) : [],
    items: rows.map(toFeedItemSummary),
    page,
    pageCount,
    pageSize: TOPIC_PAGE_SIZE,
  };
}

const STORY_TOPICS = 6;

/** The topics of a story's reports, most reports first. */
export async function topicsOfStory(storyId: number, now = new Date()): Promise<TopicLink[]> {
  const rows = await sql<{ topics: string[] }[]>`
    SELECT DISTINCT ON (p.article_id) ${topicMembership()} AS topics
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ${storyId} AND ${evidenceCondition()} AND ${storyReportCondition(now)}
    ORDER BY p.article_id`;
  const reports = new Map<string, number>();
  for (const r of rows) for (const slug of r.topics) reports.set(slug, (reports.get(slug) ?? 0) + 1);
  const slugs = [...reports].sort(([a, x], [b, y]) => y - x || position(a) - position(b)).map(([slug]) => slug);
  return topicLinks(slugs.slice(0, STORY_TOPICS));
}
