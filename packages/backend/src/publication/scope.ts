// Public scope at read time . Every query that decides whether a report is public now,
// listed, selected, or evidence of its fact uses these predicates over `publications p` (and, for
// evidence, `fact_articles fa`); no other module spells visibility, the release gate or the composite
// rule in SQL. What a publication holds is derived once, at publish time, by publish.ts and rules.ts.
import { sql } from "../db.ts";

/**
 * The release gate : a selected report appears once grouping settled or 180 s passed,
 * `visible_after`, judged at read time so no worker has to open it.
 */
export function releasedCondition(now: Date) {
  return sql`(NOT p.selected OR p.visible_after <= ${now})`;
}

/** Listed on public surfaces now: public, pool eligible, and past the release gate. */
export function listedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.eligible AND ${releasedCondition(now)}`;
}

/** Story reports include older editorial material outside the pool, but never withdrawn or gated content. */
export function storyReportCondition(now: Date) {
  return sql`p.visibility = 'public' AND s.participation_mode = 'editorial' AND ${releasedCondition(now)}`;
}

/** Selected reports still behind the release gate: caches of their scope must expire when it opens. */
export function pendingReleaseCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.selected AND p.visible_after > ${now}`;
}

/** Selected set as the website shows it (home timeline, reading groups, topics): every selected report. */
export function selectedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.selected AND p.visible_after <= ${now}`;
}


/** The report was published from a composite (multi-topic) analysis: it only mentions facts . */
export function compositeCondition() {
  return sql`EXISTS (SELECT 1 FROM analyses evidence_an WHERE evidence_an.id = p.analysis_id AND evidence_an.output->>'scope' = 'composite')`;
}

/** `fa` links report `p` to a fact as evidence: a primary or report membership, never a composite. */
export function evidenceCondition() {
  return sql`fa.role <> 'mention' AND NOT ${compositeCondition()}`;
}

/**
 * Report `p` is still evidence of its own fact (`publications.fact_id`, written at publish time): a
 * membership removed or turned into a mention since then no longer counts.
 */
export function ownFactEvidenceCondition() {
  return sql`EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.fact_id = p.fact_id AND fa.article_id = p.article_id AND ${evidenceCondition()})`;
}
