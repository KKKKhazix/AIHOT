// The saved digest's evidence and fingerprint, shared by its writer and every public reader.
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";

export interface DigestReport {
  story_id: number;
  id: string;
  title: string;
  summary: string | null;
  source_name: string;
  first_party: boolean;
  at: Date;
  fact_id: number;
  fact_subject: string | null;
  fact_action: string | null;
  fact_object: string | null;
  fact_conditions: string | null;
  evidence: string | null;
  structured_fact: unknown;
}

/** Conditions stay next to their object and source quote; no ownership is inferred from subject tags. */
export function digestFactEvidence(report: DigestReport) {
  const fact = report.structured_fact && typeof report.structured_fact === "object" ? report.structured_fact as Record<string, unknown> : {};
  const conditions = Array.isArray(fact.conditions) ? fact.conditions.flatMap((condition) => {
    if (!condition || typeof condition !== "object") return [];
    const value = condition as Record<string, unknown>;
    return typeof value.text === "string" && typeof value.quote === "string" ? [{ text: value.text, quote: value.quote }] : [];
  }) : [];
  return { subject: report.fact_subject, action: report.fact_action, object: report.fact_object,
    conditions: report.fact_conditions, evidence: report.evidence, extractedConditions: conditions,
    extractedEvidence: typeof fact.evidence === "string" ? fact.evidence : null };
}

export async function digestReports(db: Db, storyIds: number[], now = new Date()): Promise<DigestReport[]> {
  if (!storyIds.length) return [];
  return db<DigestReport[]>`
    SELECT DISTINCT ON (f.story_id, p.article_id) f.story_id, p.article_id AS id, p.title, p.summary,
      s.name AS source_name, (s.tier = 'T1') AS first_party,
      coalesce(p.published_at, p.discovered_at) AS at, f.id AS fact_id, f.subject AS fact_subject,
      f.action AS fact_action, f.object AS fact_object, f.conditions AS fact_conditions, fa.evidence,
      an.output->'fact' AS structured_fact
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id LEFT JOIN analyses an ON an.id = p.analysis_id
    WHERE f.story_id = ANY(${storyIds}::bigint[]) AND ${evidenceCondition()} AND ${listedCondition(now)}
    ORDER BY f.story_id, p.article_id, (fa.role = 'primary') DESC, f.id`;
}

export function digestInputsHash(reports: DigestReport[]): string {
  return sha256(stableJson([...reports].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.fact_id, r.title, r.summary ?? "", r.source_name, r.first_party, r.at.toISOString(), digestFactEvidence(r)])));
}
