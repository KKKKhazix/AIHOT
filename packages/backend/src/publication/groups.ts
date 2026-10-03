// Duplicate reports of one news fact ("另有 N 家信源报道"). Members must pass the same visibility, pool
// eligibility and parent-page filters as the card they open under.
import type { CategoryKey, ChannelKey } from "@aihot/contracts/taxonomy";
import type { GroupReportsResponse } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { categoryCondition, channelCondition, tagCondition } from "./items.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";
import { publicSourceName } from "./rules.ts";

export interface GroupReportsQuery {
  factPublicId: string;
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
}

/** A fact has a few dozen reports at most; the cap only bounds an odd one. */
const MAX_REPORTS = 100;

/** The fact's public reports under the filters, newest first; null when it has none. */
export async function loadGroupReports(q: GroupReportsQuery, now = new Date()): Promise<GroupReportsResponse | null> {
  const members = await sql<{ id: string; title: string; timeline_at: Date; url: string; source_name: string }[]>`
    SELECT p.article_id AS id, p.title, p.timeline_at, p.url, s.name AS source_name
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.public_id = ${q.factPublicId} AND ${evidenceCondition()} AND ${listedCondition(now)}
      ${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}
    ORDER BY p.timeline_at DESC, p.article_id ASC
    LIMIT ${MAX_REPORTS}`;
  if (members.length === 0) return null;
  return {
    factId: q.factPublicId,
    reports: members.map((m) => ({
      id: m.id,
      title: m.title,
      source: { name: publicSourceName(m.source_name) },
      timelineAt: m.timeline_at.toISOString(),
      originalUrl: m.url,
    })),
  };
}
