import { selectedCondition, pendingReleaseCondition } from "./scope.ts";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary, type ItemRow } from "./items.ts";

export interface TopicRow {
  slug: string;
  name: string;
  grp: "company" | "field" | "genre";
  entity_id: string | null;
  tags: string[];
  definition: string;
  related: string[];
  position: number;
}

type TopicCount = { slug: string; total: number; recent: number; pages: number; indexable: boolean; latest: Date | null };
const topicsCache = cached(
  () => sql<TopicRow[]>`SELECT slug, name, grp, entity_id, tags, definition, related, position FROM topics ORDER BY position`,
  { freshMs: 60_000, maxStaleMs: 10 * 60_000 },
);
export interface TopicCountSnapshot { counts: TopicCount[]; refreshAt: string | null }
// 已知的发布或近期窗口截止必须同步刷新，不能继续返回后台更新中的旧统计。
const countsCache = cached(() => queryTopicCounts(new Date()), {
  freshMs: 60_000, maxStaleMs: 10 * 60_000,
  expiresAt: (value) => value.refreshAt ? Date.parse(value.refreshAt) : null,
});

/**
 * The topics (stable slugs, names, definitions, related topics) come from the industry pack
 * (industry/topics.json); every environment seeds them from there. Re-runnable.
 */
export async function seedTopics(): Promise<number> {
  const data = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as {
    topics: Array<{ slug: string; name: string; group: string; entityId?: string | null; tags: string[]; definition: string; related?: string[] }>;
  };
  let position = 0;
  for (const t of data.topics) {
    await sql`
      INSERT INTO topics (slug, name, grp, entity_id, tags, definition, related, position)
      VALUES (${t.slug}, ${t.name}, ${t.group}, ${t.entityId ?? null}, ${t.tags}, ${t.definition}, ${t.related ?? []}, ${position++})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, grp = EXCLUDED.grp, entity_id = EXCLUDED.entity_id,
        tags = EXCLUDED.tags, definition = EXCLUDED.definition, related = EXCLUDED.related, position = EXCLUDED.position`;
  }
  topicsCache.clear();
  countsCache.clear();
  return data.topics.length;
}

export function listTopics(): Promise<TopicRow[]> {
  return topicsCache.get();
}

export async function loadTopic(slug: string): Promise<TopicRow | null> {
  return (await listTopics()).find((t) => t.slug === slug) ?? null;
}

/**
 * Tags that put an article in a topic. A company topic takes only articles actually about the company
 * (its entity subject tag), never mere mentions; field and genre topics match their tags.
 */
export function topicMatchTags(t: Pick<TopicRow, "entity_id" | "tags">): string[] {
  return t.entity_id ? [`entity:${t.entity_id}`] : t.tags;
}

export async function loadTopicTags(slug: string): Promise<string[] | null> {
  const t = await loadTopic(slug);
  return t ? topicMatchTags(t) : null;
}

export const TOPIC_PAGE_SIZE = 20;

/** Topic pages exist for every topic; only topics with enough content are listed and indexed. */
export async function topicPageCounts(now?: Date): Promise<TopicCount[]> {
  return (await topicCountSnapshot(now)).counts;
}

export function topicCountSnapshot(now?: Date): Promise<TopicCountSnapshot> {
  // 显式时间用于同一请求的计数与条目读取，不混入其他时刻的共享缓存。
  return now ? queryTopicCounts(now) : countsCache.get();
}

/**
 * One pass over the selected set (a few thousand rows from its partial index) instead of one
 * scan per topic; a topic counts an item when their tags overlap, as `p.tags && match` does.
 */
async function queryTopicCounts(now: Date): Promise<TopicCountSnapshot> {
  const [topics, items, pending] = await Promise.all([
    sql<Array<Pick<TopicRow, "slug" | "entity_id" | "tags">>>`SELECT slug, entity_id, tags FROM topics ORDER BY position`,
    sql<{ tags: string[]; timeline_at: Date }[]>`SELECT p.tags, p.timeline_at FROM publications p WHERE ${selectedCondition(now)}`,
    sql<{ t: Date | null }[]>`SELECT min(p.visible_after) AS t FROM publications p
      WHERE ${pendingReleaseCondition(now)}`,
  ]);
  const recentFrom = now.getTime() - 30 * 86400_000;
  let deadline = pending[0]?.t?.getTime() ?? Infinity;
  for (const item of items) {
    const expires = item.timeline_at.getTime() + 30 * 86400_000;
    if (expires > now.getTime()) deadline = Math.min(deadline, expires);
  }
  const counts = topics.map((t) => {
    const match = new Set(topicMatchTags(t));
    let total = 0;
    let recent = 0;
    let latest: Date | null = null;
    for (const it of items) {
      if (!it.tags.some((tag) => match.has(tag))) continue;
      total += 1;
      if (it.timeline_at.getTime() > recentFrom) recent += 1;
      if (!latest || it.timeline_at > latest) latest = it.timeline_at;
    }
    return { slug: t.slug, total, recent, latest, pages: Math.max(1, Math.ceil(total / TOPIC_PAGE_SIZE)), indexable: total >= 50 || (total >= 20 && recent > 0) };
  });
  return { counts, refreshAt: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null };
}

/** Detail pages count only their topic, while retaining the directory's global deadlines. */
async function queryTopicCount(slug: string, now: Date): Promise<{ count: TopicCount; refreshAt: string | null }> {
  // Counts use fresh matching tags, as the directory does; metadata and item tags remain cached.
  const [topic] = await sql<Array<Pick<TopicRow, "entity_id" | "tags">>>`
    SELECT entity_id, tags FROM topics WHERE slug = ${slug}`;
  const recentMs = 30 * 86400_000;
  // The directory compares JavaScript Dates, which truncate PostgreSQL's sub-millisecond precision.
  const recentStart = new Date(now.getTime() - recentMs + 1);
  const [row] = await sql<{ total: number; recent: number; latest: Date | null; pending: Date | null; oldest_recent: Date | null }[]>`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE p.timeline_at >= ${recentStart})::int AS recent,
      max(p.timeline_at) AS latest,
      (SELECT min(p.visible_after) FROM publications p WHERE ${pendingReleaseCondition(now)}) AS pending,
      (SELECT min(p.timeline_at) FROM publications p
        WHERE ${selectedCondition(now)} AND p.timeline_at >= ${recentStart}) AS oldest_recent
    FROM publications p
    WHERE ${selectedCondition(now)} AND p.tags && ${topic ? topicMatchTags(topic) : []}::text[]`;
  const { total, recent, latest } = row!;
  const deadline = Math.min(row!.pending?.getTime() ?? Infinity, row!.oldest_recent ? row!.oldest_recent.getTime() + recentMs : Infinity);
  return {
    count: { slug, total, recent, latest, pages: Math.max(1, Math.ceil(total / TOPIC_PAGE_SIZE)), indexable: total >= 50 || (total >= 20 && recent > 0) },
    refreshAt: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null,
  };
}

export interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function listTopicSummaries(now?: Date): Promise<TopicSummary[]> {
  return (await loadTopicDirectory(now)).topics;
}

export async function loadTopicDirectory(now?: Date): Promise<{ topics: TopicSummary[]; refreshAt: string | null }> {
  const [topics, snapshot] = await Promise.all([listTopics(), topicCountSnapshot(now)]);
  const counts = new Map(snapshot.counts.map((c) => [c.slug, c]));
  const summaries = topics.map((t) => {
    const c = counts.get(t.slug);
    return { slug: t.slug, name: t.name, group: t.grp, definition: t.definition, total: c?.total ?? 0, recent: c?.recent ?? 0, indexable: c?.indexable ?? false, latestAt: c?.latest?.toISOString() ?? null };
  });
  return { topics: summaries, refreshAt: snapshot.refreshAt };
}

export interface TopicPage {
  topic: TopicSummary & { related: Array<{ slug: string; name: string }> };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  refreshAt: string | null;
}

export async function loadTopicPage(slug: string, page: number, now = new Date()): Promise<TopicPage | null> {
  const topics = await listTopics();
  const row = topics.find((t) => t.slug === slug);
  if (!row || !Number.isInteger(page) || page < 1) return null;
  const { count, refreshAt } = await queryTopicCount(slug, now);
  const topic: TopicSummary = { slug: row.slug, name: row.name, group: row.grp, definition: row.definition,
    total: count.total, recent: count.recent, indexable: count.indexable, latestAt: count.latest?.toISOString() ?? null };
  const pageCount = count.pages;
  if (page < 1 || page > pageCount) return null;
  // Page ids from the selected set first, then the joins for those rows only.
  const rows = await sql<ItemRow[]>`
    WITH page AS (
      SELECT p.article_id FROM publications p
      WHERE ${selectedCondition(now)} AND p.tags && ${topicMatchTags(row)}::text[]
      ORDER BY p.timeline_at DESC, p.article_id DESC
      LIMIT ${TOPIC_PAGE_SIZE} OFFSET ${(page - 1) * TOPIC_PAGE_SIZE})
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
    ORDER BY p.timeline_at DESC, p.article_id DESC`;
  const related = row.related.map((r) => topics.find((t) => t.slug === r)).filter((t): t is TopicRow => !!t).map((t) => ({ slug: t.slug, name: t.name }));
  return { topic: { ...topic, related }, items: rows.map(toFeedItemSummary), page, pageCount, refreshAt };
}
