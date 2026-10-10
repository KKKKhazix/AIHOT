// Saved bridge judgements remain evidence after the recall window; an explicit change to the
// judgement, publication or fact membership can invalidate them without deleting the link history.
// A judgement counts for the story its fact is in now, as links are made, so a story merge carries it along.
import { sql } from "../db.ts";
import { latestCompositeCondition, storyReportCondition } from "../publication/scope.ts";
import { TIE_MIN_CONFIDENCE } from "./relate.ts";

export const RELATED_MIN_REPORTS = 2;

/** One row per known bridge report, with its current validity. Missing history proves no revocation. */
export function relatedEvidence(story: ReturnType<typeof sql>, other: ReturnType<typeof sql>, now: Date) {
  return sql`(
    WITH judged AS (
      SELECT DISTINCT d.id, d.article_id, d.fact_id FROM facts own
      JOIN grouping_decisions d ON d.fact_id = own.id
      CROSS JOIN LATERAL jsonb_array_elements(d.candidates) c
      JOIN facts candidate ON candidate.id = (c->>'id')::bigint
      WHERE own.story_id IN (${story}, ${other})
        AND d.verdict IN ('same-fact', 'same-url', 'new-fact-in-story', 'new-story')
        AND c->>'relation' IN ('SAME_OCCURRENCE', 'SAME_STORY') AND (c->>'confidence')::numeric >= ${TIE_MIN_CONFIDENCE}
        AND ((own.story_id = ${story} AND candidate.story_id = ${other})
          OR (own.story_id = ${other} AND candidate.story_id = ${story}))),
    latest AS (
      SELECT d.article_id, max(d.id) AS id FROM grouping_decisions d
      WHERE d.article_id IN (SELECT article_id FROM judged) AND d.verdict <> 'kept'
      GROUP BY d.article_id)
    SELECT j.article_id, bool_or((j.id = latest.id
      AND ${storyReportCondition(now)} AND NOT ${latestCompositeCondition(sql`j.article_id`)}
      AND EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.article_id = j.article_id
        AND fa.fact_id = j.fact_id AND fa.role IN ('primary', 'report'))) IS TRUE) AS valid
    FROM judged j JOIN latest ON latest.article_id = j.article_id
    LEFT JOIN publications p ON p.article_id = j.article_id LEFT JOIN sources s ON s.id = p.source_id
    GROUP BY j.article_id
  )`;
}
