// "事件后续" on an article page: the news facts of its event that made 精选, newest first.
import type { StoryFollowupsResponse } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeIdentity } from "./representative.ts";
import { publicSourceName } from "./rules.ts";
import { ownFactEvidenceCondition, selectedCondition } from "./scope.ts";

const SHOWN = 8;

type Member = RepresentativeIdentity & {
  fact_id: number; fact_public_id: string; id: string; title: string; source_name: string;
  body_mode: "full" | "summary"; score: number | null; timeline_at: Date; sort_at: Date;
};

/**
 * Each fact of the story with a selected report still evidence of it: its representative, the facts
 * ordered by when they first appeared. Null for an unknown or merged story, or one without any.
 */
export async function loadStoryFollowups(storyPublicId: string, now = new Date()): Promise<StoryFollowupsResponse | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storyPublicId)) return null;
  const members = await sql<Member[]>`
    SELECT p.fact_id, f.public_id AS fact_public_id, p.article_id AS id, p.title, s.name AS source_name,
      p.body_mode, p.score, p.timeline_at, p.sort_at, ${REPRESENTATIVE_COLUMNS}
    FROM stories st JOIN publications p ON p.story_id = st.id JOIN sources s ON s.id = p.source_id JOIN facts f ON f.id = p.fact_id
    WHERE st.public_id = ${storyPublicId} AND st.merged_into IS NULL AND ${selectedCondition(now)} AND ${ownFactEvidenceCondition()}`;
  const byFact = new Map<number, Member[]>();
  for (const m of members) byFact.set(m.fact_id, [...(byFact.get(m.fact_id) ?? []), m]);
  if (byFact.size === 0) return null;
  const facts = [...byFact.values()]
    .map((reports) => ({
      factId: reports[0]!.fact_public_id,
      first: Math.min(...reports.map((r) => r.sort_at.getTime())),
      representative: pickRepresentative(reports),
    }))
    .sort((a, b) => b.first - a.first || a.factId.localeCompare(b.factId));
  return {
    items: facts.slice(0, SHOWN).map(({ factId, representative: r }) => ({
      factId,
      representative: { id: r.id, title: r.title, source: { name: publicSourceName(r.source_name) }, timelineAt: r.timeline_at.toISOString() },
    })),
    more: facts.length > SHOWN,
  };
}
