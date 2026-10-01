// Stories (events) and the hot ranking through the public read layer. The website sees heat values;
// v1 / MCP / Skill only see ranks and counts.
import type { HeatPoint, HotResponse, StoryDetail, StoryReportView } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { latestHotRanking, rankingExtras } from "./hot.ts";
import { behindSources, currentSignals, heatSeries, sourceClocks } from "../events/hot.ts";
import { evidenceCondition, listedCondition, storyReportCondition } from "./scope.ts";
import { itemUrl, storyApiUrl, storyUrl } from "./links.ts";
import { SITE } from "@aihot/industry/site";

function storyStatusFor(latestAt: Date | null, now = Date.now()): "active" | "watching" | "settled" {
  if (!latestAt) return "settled";
  const age = now - latestAt.getTime();
  return age < 24 * 3600_000 ? "active" : age < 72 * 3600_000 ? "watching" : "settled";
}

export type StoryLookup = { kind: "found"; storyId: number; publicId: string } | { kind: "merged"; target: string } | { kind: "not_found" };

export async function resolveStory(publicId: string): Promise<StoryLookup> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicId)) return { kind: "not_found" };
  const [s] = await sql<{ id: number; merged_into: number | null }[]>`SELECT id, merged_into FROM stories WHERE public_id = ${publicId}`;
  let targetId: number | null = s ? (s.merged_into ?? null) : null;
  if (!s) {
    const [alias] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_aliases WHERE public_id = ${publicId}`;
    if (!alias) return { kind: "not_found" };
    targetId = alias.story_id;
  }
  if (targetId) {
    // Follow merge chains to the surviving story.
    for (let i = 0; i < 10; i++) {
      const rows: Array<{ id: number; public_id: string; merged_into: number | null }> = await sql`SELECT id, public_id::text, merged_into FROM stories WHERE id = ${targetId}`;
      const t = rows[0];
      if (!t) return { kind: "not_found" };
      if (!t.merged_into) return { kind: "merged", target: t.public_id };
      targetId = t.merged_into;
    }
    return { kind: "not_found" };
  }
  return { kind: "found", storyId: s!.id, publicId };
}

interface ReportRow {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  selected: boolean;
  at: Date;
  source_id: string;
  source_name: string;
  source_kind: string;
  first_party: boolean;
  icon_url: string | null;
  fact_public_id: string;
  fact_id: number;
}

/**
 * Every report linked to the story's facts that has a public page (rules.hasItemPage: editorial source,
 * summarised or not), mentions included (an article's other events). New grouping only links
 * pool-eligible articles; imported hot stories also carry reports the AI pool leaves out, which the live
 * pages showed. hot_signal material only adds heat and is not listed, as on the live pages.
 */
async function storyReports(storyId: number, now: Date): Promise<ReportRow[]> {
  return sql<ReportRow[]>`
    SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.title, p.summary, p.url, p.selected,
      coalesce(p.published_at, p.discovered_at) AS at, s.id AS source_id, s.name AS source_name, s.kind AS source_kind,
      p.first_party, s.icon_url, f.public_id AS fact_public_id, f.id AS fact_id
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ${storyId} AND ${storyReportCondition(now)}
    ORDER BY p.article_id, (fa.role = 'primary') DESC`;
}

function reportView(r: ReportRow): StoryReportView {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    source: { id: r.source_id, name: r.source_name, kind: r.source_kind as never, firstParty: r.first_party, iconUrl: proxiedImage(r.icon_url, "avatar") },
    publishedAt: r.at.toISOString(),
    originalUrl: r.url,
    selected: r.selected,
    factId: r.fact_public_id,
  };
}

async function storyContent(storyId: number, now: Date) {
  const [s] = await sql<{ public_id: string; title: string; summary: string | null; first_report_at: Date | null; latest_at: Date | null; digest: string | null; digest_updated_at: Date | null; latest: string | null }[]>`
    SELECT public_id::text, title, summary, first_report_at, latest_at, digest, digest_updated_at, latest FROM stories WHERE id = ${storyId}`;
  if (!s) return null;
  const reports = await storyReports(storyId, now);
  if (reports.length === 0) return null;
  reports.sort((a, b) => b.at.getTime() - a.at.getTime());

  const byFact = new Map<number, ReportRow[]>();
  for (const r of reports) byFact.set(r.fact_id, [...(byFact.get(r.fact_id) ?? []), r]);
  const facts = await sql<{ id: number; public_id: string; title: string; occurred_at: Date | null; created_at: Date }[]>`
    SELECT id, public_id, title, occurred_at, created_at FROM facts WHERE story_id = ${storyId}`;
  const developments = facts
    .filter((f) => byFact.has(f.id))
    .map((f) => {
      const members = byFact.get(f.id)!;
      const rep = [...members].sort((a, b) => Number(b.first_party) - Number(a.first_party) || Number(b.selected) - Number(a.selected) || a.at.getTime() - b.at.getTime())[0]!;
      const first = members.reduce((m, r) => (r.at < m ? r.at : m), members[0]!.at);
      return { factId: f.public_id, title: f.title, occurredAt: f.occurred_at?.toISOString() ?? null, firstReportAt: first.toISOString(), reportCount: members.length, representative: rep };
    })
    .sort((a, b) => Date.parse(b.firstReportAt) - Date.parse(a.firstReportAt));

  return { s, reports, developments };
}

async function relatedStories(storyId: number, now: Date) {
  return sql<{ public_id: string; title: string; relation: "storyline" | "related"; latest_at: Date | null }[]>`
    SELECT st.public_id::text, st.title, l.relation, st.latest_at FROM story_links l JOIN stories st ON st.id = l.other_id
    WHERE l.story_id = ${storyId} AND st.merged_into IS NULL AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      JOIN sources s ON s.id = p.source_id
      WHERE f.story_id = st.id AND ${evidenceCondition()} AND ${storyReportCondition(now)}
    ) ORDER BY st.latest_at DESC NULLS LAST LIMIT 8`;
}

export async function loadStoryDetail(storyId: number, now = new Date()): Promise<StoryDetail | null> {
  const content = await storyContent(storyId, now);
  if (!content) return null;
  const { s, reports, developments } = content;
  const [why] = await sql<{ p48: number; p6: number; r24: number }[]>`
    WITH cs AS (SELECT * FROM ${currentSignals()} c WHERE story_id = ${storyId} AND observed_at <= ${now})
    SELECT count(DISTINCT participant_key) FILTER (WHERE observed_at > ${now}::timestamptz - interval '48 hours') AS p48,
           count(DISTINCT participant_key) FILTER (WHERE observed_at > ${now}::timestamptz - interval '6 hours'
             AND participant_key NOT IN (SELECT participant_key FROM cs x WHERE x.observed_at <= ${now}::timestamptz - interval '6 hours')) AS p6,
           count(*) FILTER (WHERE kind = 'editorial' AND observed_at > ${now}::timestamptz - interval '24 hours') AS r24
    FROM cs`;
  const ranking = await latestHotRanking();
  const entry = ranking?.entries.find((e) => e.storyId === storyId) ?? null;
  // Only hours observed in full are drawn (the chart leaves a gap otherwise).
  const heat = await heatSeries(storyId, now);
  // Complete when none of the sources behind the last 48 hours' participants is behind on collection.
  const behind = behindSources(await sourceClocks(), now.getTime(), true);
  const [partial] = behind.length
    ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${currentSignals()} cs WHERE story_id = ${storyId} AND source_id = ANY(${behind}::text[])
                                  AND observed_at > ${now}::timestamptz - interval '48 hours' AND observed_at <= ${now}`
    : [{ n: 0 }];
  const related = await relatedStories(storyId, now);
  const latestAt = reports[0]!.at;
  // Without a digest or a summary of its own, the story opens with its first development's representative report.
  const origin = developments[developments.length - 1]?.representative;
  return {
    publicId: s.public_id,
    title: s.title,
    status: storyStatusFor(latestAt, now.getTime()),
    reportCount: reports.length,
    sourceCount: new Set(reports.map((r) => r.source_id)).size,
    firstReportAt: reports[reports.length - 1]!.at.toISOString(),
    latestAt: latestAt.toISOString(),
    digest: s.digest,
    digestUpdatedAt: s.digest_updated_at?.toISOString() ?? null,
    summary: s.summary,
    excerpt: !s.digest && !s.summary && origin?.summary ? { text: origin.summary, sourceName: origin.source_name } : null,
    latest: s.latest,
    whyHot: {
      participants48h: Number(why?.p48 ?? 0),
      newParticipants6h: Number(why?.p6 ?? 0),
      recentReports24h: Number(why?.r24 ?? 0),
      observationComplete: !partial?.n,
      rank: entry?.rank ?? null,
      heat: entry?.heat ?? null,
    },
    developments: developments.map((d) => ({ ...d, representative: reportView(d.representative) })),
    officialReports: reports.filter((r) => r.first_party).slice(0, 12).map(reportView),
    timeline: reports.slice(0, 100).map(reportView),
    heat: heat.map((h): HeatPoint => ({ hour: h.hour.toISOString(), heat: Number(h.heat), participants: h.participants })),
    related: related.map((r) => ({ publicId: r.public_id, title: r.title, relation: r.relation, latestAt: r.latest_at?.toISOString() ?? null })),
  };
}

const SPARK_HOURS = 24;

/** Hourly heat of the ranked stories over the day before the ranking, one slot per hour. */
async function sparklines(storyIds: number[], at: Date): Promise<Map<number, Array<number | null>>> {
  const end = Math.floor(at.getTime() / 3600000) * 3600000;
  const start = end - SPARK_HOURS * 3600000;
  const rows = storyIds.length
    ? await sql<{ story_id: number; hour: Date; heat: string }[]>`
        SELECT story_id, hour, heat FROM story_heat_hourly
        WHERE story_id = ANY(${storyIds}::bigint[]) AND complete AND hour >= ${new Date(start)} AND hour <= ${new Date(end)}`
    : [];
  const out = new Map<number, Array<number | null>>(storyIds.map((id) => [id, Array.from({ length: SPARK_HOURS + 1 }, () => null)]));
  for (const r of rows) {
    const slot = Math.round((r.hour.getTime() - start) / 3600000);
    const line = out.get(Number(r.story_id));
    if (line && slot >= 0 && slot <= SPARK_HOURS) line[slot] = Number(r.heat);
  }
  return out;
}

// Coalesce concurrent reads, but re-check visibility and full-text permission on later requests.
type HotCoverMap = Map<number, { url: string; width: number | null; height: number | null }>;
const coversPending = new Map<number, Promise<HotCoverMap>>();

/** A picture per story from its public full-text reports, the representative first, wide enough for a card. */
async function hotCovers(rankingId: number, entries: Array<{ storyId: number; representativeItemId: string | null }>, at: Date) {
  const pending = coversPending.get(rankingId);
  if (pending) return pending;
  const load = queryHotCovers(entries, at);
  coversPending.set(rankingId, load);
  try { return await load; }
  finally { coversPending.delete(rankingId); }
}

async function queryHotCovers(entries: Array<{ storyId: number; representativeItemId: string | null }>, at: Date) {
  const ids = entries.map((e) => e.storyId);
  const reps = entries.map((e) => e.representativeItemId).filter((id): id is string => !!id);
  const rows = await sql<{ story_id: number; m: { url: string; width?: number; height?: number } }[]>`
    SELECT DISTINCT ON (p.story_id) p.story_id, img.m
    FROM publications p JOIN articles a ON a.id = p.article_id
    CROSS JOIN LATERAL (
      SELECT m FROM jsonb_array_elements(coalesce(a.media, '[]'::jsonb)) m
      WHERE m->>'kind' = 'image' AND coalesce((m->>'width')::numeric, 800) >= 480 LIMIT 1
    ) img
    WHERE p.story_id = ANY(${ids}::bigint[]) AND ${listedCondition(at)} AND p.body_mode <> 'summary'
    ORDER BY p.story_id, (p.article_id::text = ANY(${reps}::text[])) DESC, p.first_party DESC, p.selected DESC, coalesce(p.score, 0) DESC, p.article_id`;
  const covers = new Map(rows.map((c) => [Number(c.story_id), { url: c.m.url, width: typeof c.m.width === "number" ? c.m.width : null, height: typeof c.m.height === "number" ? c.m.height : null }]));
  return covers;
}

export async function loadHot(): Promise<HotResponse> {
  const ranking = await latestHotRanking();
  if (!ranking) return { computedAt: null, ruleVersion: null, windowHours: 48, entries: [] };
  const at = new Date(ranking.computedAt);
  const [sparks, covers, extras] = await Promise.all([
    sparklines(
      ranking.entries.map((e) => e.storyId),
      at,
    ),
    hotCovers(ranking.id, ranking.entries, new Date()),
    rankingExtras(ranking),
  ]);
  return {
    computedAt: ranking.computedAt,
    ruleVersion: ranking.ruleVersion,
    windowHours: 48,
    entries: ranking.entries.map((e) => {
      const picture = covers.get(e.storyId);
      const coverUrl = picture ? proxiedImage(picture.url, "full") : null;
      const text = extras.text(e);
      return {
        rank: e.rank,
        story: { publicId: e.storyPublicId, title: e.title },
        heat: e.heat,
        trend: e.trend,
        trendPct: e.trendPct,
        badges: e.badges,
        participantCount: e.participantCount,
        sourceCount: e.sourceCount,
        signalCount: e.signalCount,
        reportCount: e.reportCount,
        sourceNames: e.sourceNames,
        latestAt: e.latestAt,
        firstReportAt: e.firstReportAt,
        representative: e.representativeItemId ? { id: e.representativeItemId, url: e.representativeUrl ?? "", sourceName: e.representativeSource ?? "" } : null,
        participants: extras.participants(e),
        spark: sparks.get(e.storyId) ?? [],
        summary: text.summary,
        latest: text.latest,
        cover: picture && coverUrl ? { url: coverUrl, srcSet: proxiedImageSet(picture.url, "hero") ?? undefined, width: picture.width, height: picture.height } : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// v1 shapes (ranks and counts only; no heat values)
// ---------------------------------------------------------------------------

export async function v1HotTopics() {
  const ranking = await latestHotRanking();
  const items = (ranking?.entries ?? []).map((e) => ({
    rank: e.rank,
    id: e.representativeItemId ?? e.storyPublicId,
    title: e.title,
    source: { name: e.representativeSource ?? e.sourceNames[0] ?? SITE.name },
    links: {
      aihot: e.representativeItemId ? itemUrl(e.representativeItemId) : storyUrl(e.storyPublicId),
      original: e.representativeUrl ?? storyUrl(e.storyPublicId),
      story: storyUrl(e.storyPublicId),
    },
    sourceCount: e.sourceCount,
    signalCount: e.signalCount,
    participantCount: e.participantCount,
    sourceNames: e.sourceNames,
    latestAt: new Date(e.latestAt).toISOString(),
  }));
  return { schemaVersion: 1 as const, count: items.length, items };
}

export async function v1Story(storyId: number) {
  const now = new Date();
  const content = await storyContent(storyId, now);
  if (!content) return null;
  const { s, reports, developments } = content;
  const latestAt = reports[0]!.at;
  const neighbors = (await relatedStories(storyId, now)).map((r) => ({ publicId: r.public_id, title: r.title, relation: r.relation, links: { aihot: storyUrl(r.public_id), api: storyApiUrl(r.public_id) } }));
  return {
    schemaVersion: 1 as const,
    story: {
      publicId: s.public_id,
      title: s.title,
      status: storyStatusFor(latestAt, now.getTime()) === "settled" ? ("settled" as const) : ("active" as const),
      sourceCount: new Set(reports.map((r) => r.source_id)).size,
      reportCount: reports.length,
      firstReportAt: reports[reports.length - 1]!.at.toISOString(),
      latestAt: latestAt.toISOString(),
      latest: s.latest ?? developments[0]?.title ?? s.title,
      digest: s.digest,
      digestUpdatedAt: s.digest_updated_at?.toISOString() ?? null,
      links: { aihot: storyUrl(s.public_id) },
      reports: reports.slice(0, 50).map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        source: { name: r.source_name, firstParty: r.first_party },
        publishedAt: r.at.toISOString(),
        links: { aihot: itemUrl(r.id), original: r.url },
      })),
      storyline: neighbors.filter((n) => n.relation === "storyline"),
      related: neighbors.filter((n) => n.relation === "related"),
    },
  };
}
