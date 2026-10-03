// What the site tells readers about an event (the hot list and the event page), by the rule the digest is
// written by (events/digest.ts): its listed evidence. A digest stands while every report it was written
// from still is; the latest development is the newest such report.
import { sql } from "../db.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";

export interface StoryText {
  digest: string | null;
  digestUpdatedAt: Date | null;
  /** The story's own factual summary. */
  summary: string | null;
  /** Its title, link and time come from the one report. */
  latest: { id: string; title: string; at: Date } | null;
}

export async function storyTexts(storyIds: number[], now = new Date()): Promise<Map<number, StoryText>> {
  if (storyIds.length === 0) return new Map();
  const rows = await sql<{ id: number; digest: string | null; digest_updated_at: Date | null; current: boolean; summary: string | null; latest_id: string | null; latest_title: string; latest_at: Date }[]>`
    SELECT st.id, st.digest, st.digest_updated_at, st.summary,
      NOT EXISTS (
        SELECT 1 FROM unnest((SELECT article_ids FROM story_digests WHERE story_id = st.id ORDER BY version DESC LIMIT 1)) AS input(article_id)
        WHERE NOT EXISTS (SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
          WHERE f.story_id = st.id AND p.article_id = input.article_id AND ${evidenceCondition()} AND ${listedCondition(now)})
      ) AS current,
      latest.id AS latest_id, latest.title AS latest_title, latest.at AS latest_at
    FROM stories st LEFT JOIN LATERAL (
      SELECT p.article_id AS id, p.title, coalesce(p.published_at, p.discovered_at) AS at
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = st.id AND ${evidenceCondition()} AND ${listedCondition(now)}
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id LIMIT 1
    ) latest ON true
    WHERE st.id = ANY(${storyIds}::bigint[])`;
  return new Map(rows.map((r) => [Number(r.id), {
    digest: r.current ? r.digest : null,
    digestUpdatedAt: r.current ? r.digest_updated_at : null,
    summary: r.summary,
    latest: r.latest_id ? { id: r.latest_id, title: r.latest_title, at: r.latest_at } : null,
  }]));
}
