// What the site tells readers about an event (the hot list and the event page), by the rule the digest is
// written by (events/digest.ts): its listed evidence. A digest stands while its saved evidence remains
// public and unchanged; the latest development is the newest listed evidence.
import { sql } from "../db.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";
import { digestInputsHash, digestReports } from "./story-evidence.ts";

export interface StoryText {
  digest: string | null;
  digestUpdatedAt: Date | null;
  /** A saved event summary still supported verbatim by a current public report. */
  summary: string | null;
  /** Its title, link and time come from the one report. */
  latest: { id: string; title: string; at: Date } | null;
}

export async function storyTexts(storyIds: number[], now = new Date()): Promise<Map<number, StoryText>> {
  if (storyIds.length === 0) return new Map();
  const rows = await sql<{ id: number; digest: string | null; digest_updated_at: Date | null; article_ids: string[] | null; inputs_hash: string | null; current: boolean; summary: string | null; latest_id: string | null; latest_title: string; latest_at: Date }[]>`
    SELECT st.id, st.digest, st.digest_updated_at, saved.article_ids, saved.inputs_hash,
      CASE WHEN EXISTS (
        SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
        WHERE f.story_id = st.id AND p.summary = st.summary AND ${evidenceCondition()} AND ${listedCondition(now)}
      ) THEN st.summary END AS summary,
      coalesce(st.digest = saved.digest, false) AND NOT EXISTS (
        SELECT 1 FROM unnest(saved.article_ids) AS input(article_id)
        WHERE NOT EXISTS (SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
          WHERE f.story_id = st.id AND p.article_id = input.article_id AND ${evidenceCondition()} AND ${listedCondition(now)})
      ) AS current,
      latest.id AS latest_id, latest.title AS latest_title, latest.at AS latest_at
    FROM stories st LEFT JOIN LATERAL (
      SELECT article_ids, inputs_hash, digest FROM story_digests WHERE story_id = st.id ORDER BY version DESC LIMIT 1
    ) saved ON true LEFT JOIN LATERAL (
      SELECT p.article_id AS id, p.title, coalesce(p.published_at, p.discovered_at) AS at
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = st.id AND ${evidenceCondition()} AND ${listedCondition(now)}
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id LIMIT 1
    ) latest ON true
    WHERE st.id = ANY(${storyIds}::bigint[])`;
  const reports = await digestReports(sql, rows.filter((r) => r.current && r.digest && r.inputs_hash).map((r) => Number(r.id)), now);
  return new Map(rows.map((r) => {
    // New reports may extend an event without changing the evidence behind its saved digest.
    const saved = new Set(r.article_ids ?? []);
    const current = r.current && saved.size > 0 && !!r.inputs_hash
      && digestInputsHash(reports.filter((p) => Number(p.story_id) === Number(r.id) && saved.has(p.id))) === r.inputs_hash;
    return [Number(r.id), {
      digest: current ? r.digest : null,
      digestUpdatedAt: current ? r.digest_updated_at : null,
      summary: r.summary,
      latest: r.latest_id ? { id: r.latest_id, title: r.latest_title, at: r.latest_at } : null,
    }];
  }));
}
