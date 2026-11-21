// The saved digest's evidence and fingerprint, shared by its writer and every public reader.
import { type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { publicSourceName } from "./rules.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";

export interface DigestReport {
  story_id: number;
  id: string;
  title: string;
  summary: string | null;
  source_id: string;
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
export function digestFactEvidence(report: Pick<DigestReport, "fact_subject" | "fact_action" | "fact_object" | "fact_conditions" | "evidence" | "structured_fact">) {
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
      s.id AS source_id, s.name AS source_name, (s.tier = 'T1') AS first_party,
      coalesce(p.published_at, p.discovered_at) AS at, f.id AS fact_id, f.subject AS fact_subject,
      f.action AS fact_action, f.object AS fact_object,
      CASE WHEN NOT p.suppress_original THEN f.conditions END AS fact_conditions,
      CASE WHEN NOT p.suppress_original THEN fa.evidence END AS evidence,
      CASE WHEN NOT p.suppress_original THEN an.output->'fact' END AS structured_fact
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id LEFT JOIN analyses an ON an.id = p.analysis_id
    WHERE f.story_id = ANY(${storyIds}::bigint[]) AND ${evidenceCondition()} AND ${listedCondition(now)}
    ORDER BY f.story_id, p.article_id, (fa.role = 'primary') DESC, f.id`;
}

/** Public-facing evidence fingerprint: admin parenthetical notes in sources.name do not invalidate a digest. */
export function digestInputsHash(reports: DigestReport[]): string {
  return sha256(stableJson([...reports].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.fact_id, r.title, r.summary ?? "", r.source_id, publicSourceName(r.source_name), r.first_party, r.at.toISOString(), digestFactEvidence(r)])));
}

/** Pre-versioned digest fingerprint kept only to validate historical story_digests rows written before digest_version existed. */
function legacyDigestInputsHash(reports: DigestReport[]): string {
  return sha256(stableJson([...reports].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.fact_id, r.title, r.summary ?? "", r.source_name, r.first_party, r.at.toISOString(), digestFactEvidence(r)])));
}

export function digestInputsHashMatches(reports: DigestReport[], savedHash: string | null, digestVersion: number | null): boolean {
  if (!savedHash) return false;
  if (digestInputsHash(reports) === savedHash) return true;
  return digestVersion === null && legacyDigestInputsHash(reports) === savedHash;
}
