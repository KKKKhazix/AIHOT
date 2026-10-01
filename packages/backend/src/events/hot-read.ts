// Reading the latest published hot ranking. The web shows heat values; machine exits only ranks.
import type { HotParticipant, HotStripEntry } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";

export interface HotEntry {
  rank: number;
  storyId: number;
  storyPublicId: string;
  title: string;
  heat: number;
  /** "unknown": the earlier participants' sources were behind on collection, so there is no comparison. */
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising">;
  participantCount: number;
  sourceCount: number;
  signalCount: number;
  reportCount: number;
  sourceNames: string[];
  latestAt: string;
  firstReportAt: string;
  representativeItemId: string | null;
  representativeUrl: string | null;
  representativeSource: string | null;
  /** 精选组 first by tier, then 氛围组; tier is absent on rankings from before 2026-09-29. */
  participants: Array<{ name: string; kind: "editorial" | "signal"; tier?: string }>;
}

/** Faces are the 精选组 sources, T1 before T1.5 before T2; the rest (and 氛围组) count in "+N". */
const MAX_FACES = 6;
const TIER_ORDER = ["T1", "T1_5", "T2"];
export function tierRank(tier: string | undefined): number {
  const i = TIER_ORDER.indexOf(tier ?? "");
  return i < 0 ? TIER_ORDER.length : i;
}

export interface HotRanking {
  id: number;
  computedAt: string;
  ruleVersion: string;
  entries: HotEntry[];
  coverage: Record<string, unknown> | null;
}

export function latestHotRanking(): Promise<HotRanking | null> {
  return queryLatestHotRanking();
}

async function queryLatestHotRanking(): Promise<HotRanking | null> {
  const [row] = await sql<{ id: number; computed_at: Date; rule_version: string; entries: HotEntry[]; evidence: Record<string, unknown> | null }[]>`
    SELECT id, computed_at, rule_version, entries, evidence FROM hot_rankings WHERE published ORDER BY computed_at DESC LIMIT 1`;
  if (!row) return null;
  const ids = row.entries.map(e => e.storyId);
  const current = ids.length ? await sql<{ id: number; title: string; article_id: string | null; url: string | null; source_name: string | null }[]>`
    SELECT st.id,st.title,rep.article_id,rep.url,rep.source_name FROM stories st
    LEFT JOIN LATERAL (
      SELECT p.article_id,p.url,s.name AS source_name FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
      JOIN publications p ON p.article_id=fa.article_id JOIN sources s ON s.id=p.source_id
      WHERE f.story_id=st.id AND p.visibility='public' AND p.eligible AND s.participation_mode='editorial'
        AND (NOT p.selected OR p.visible_after<=${new Date()})
      ORDER BY p.first_party DESC,p.selected DESC,p.score DESC NULLS LAST,p.article_id LIMIT 1
    ) rep ON true WHERE st.id=ANY(${ids}::bigint[]) AND st.merged_into IS NULL` : [];
  const byId = new Map(current.map(s => [s.id, s]));
  // 榜单保留热度快照，文字和代表稿每次按当前权限读取，不复用嵌入的旧标题。
  const entries = row.entries.flatMap(e => {
    const story = byId.get(e.storyId);
    return story ? [{ ...e, title: story.title, representativeItemId: story.article_id,
      representativeUrl: story.url, representativeSource: story.source_name }] : [];
  });
  return { id: row.id, computedAt: row.computed_at.toISOString(), ruleVersion: row.rule_version, entries, coverage: row.evidence };
}

// 头像沿用榜单缓存；可能因撤回变化的事件文字每次重新读取。
interface Extras {
  faces: Map<string, string | null>;
}
let extrasCache: { rankingId: number; extras: Extras } | null = null;
const extrasPending = new Map<number, Promise<Extras>>();

async function readExtras(ranking: HotRanking): Promise<Extras> {
  if (extrasCache?.rankingId === ranking.id) return extrasCache.extras;
  const pending = extrasPending.get(ranking.id);
  if (pending) return pending;
  const load = queryExtras(ranking);
  extrasPending.set(ranking.id, load);
  try { return await load; }
  finally { extrasPending.delete(ranking.id); }
}

async function queryExtras(ranking: HotRanking): Promise<Extras> {
  const ids = ranking.entries.map((e) => e.storyId);
  const faces = await sql<{ name: string; icon_url: string | null; avatar: string | null }[]>`
      SELECT DISTINCT ON (s.id) s.name, s.icon_url, a.x_post->>'avatarUrl' AS avatar
      FROM story_signals ss JOIN sources s ON s.id = ss.source_id
      LEFT JOIN articles a ON a.id = ss.article_id AND a.x_post ? 'avatarUrl'
      WHERE ss.story_id = ANY(${ids}::bigint[])
      ORDER BY s.id, (a.id IS NULL), a.discovered_at DESC`;
  const extras: Extras = {
    faces: new Map(faces.map((f) => [f.name, f.icon_url ?? f.avatar])),
  };
  extrasCache = { rankingId: ranking.id, extras };
  return extras;
}

/**
 * What the web adds to a ranking entry: participants with proxied faces in the order Faces shows them
 * (精选组 by tier, a real face before an initial within a tier, then 氛围组), the digest and the latest turn.
 */
export async function rankingExtras(ranking: HotRanking) {
  const [stable, rows] = await Promise.all([
    readExtras(ranking),
    sql<{ id: number; digest: string | null; summary: string | null; latest: string | null }[]>`
      SELECT id,digest,summary,latest FROM stories WHERE id=ANY(${ranking.entries.map(e => e.storyId)}::bigint[])`,
  ]);
  const { faces } = stable;
  const texts = new Map(rows.map(r => [r.id, { summary: r.digest ?? r.summary, latest: r.latest }]));
  return {
    participants: (e: HotEntry): HotParticipant[] => {
      const people = e.participants
        .map((p, i) => ({ p, i, icon: faces.get(p.name) ?? null }))
        .sort((x, y) => Number(y.p.kind === "editorial") - Number(x.p.kind === "editorial") || tierRank(x.p.tier) - tierRank(y.p.tier) || Number(!!y.icon) - Number(!!x.icon) || x.i - y.i);
      // Every name stays for the tooltip; only visible Faces need srcSet.
      return people.map(({ p, icon }, i): HotParticipant => {
        const person: HotParticipant = { name: p.name, kind: p.kind, iconUrl: proxiedImage(icon, "avatar") };
        const srcSet = p.kind === "editorial" && i < MAX_FACES ? proxiedImageSet(icon, "avatar") : undefined;
        if (srcSet) person.iconSrcSet = srcSet;
        return person;
      });
    },
    text: (e: HotEntry) => texts.get(e.storyId) ?? { summary: null, latest: null },
  };
}

/** Home "current hot" strip: 3–5 entries from the same ranking, hidden when there are fewer than 3. */
export async function loadHotStrip(): Promise<HotStripEntry[] | null> {
  const ranking = await latestHotRanking();
  if (!ranking || ranking.entries.length < 3) return null;
  const extras = await rankingExtras(ranking);
  return ranking.entries.slice(0, 5).map((e) => ({
    rank: e.rank,
    title: e.title,
    heat: e.heat,
    trend: e.trend,
    storyPublicId: e.storyPublicId,
    itemId: e.representativeItemId,
    participants: extras.participants(e),
    participantCount: e.participantCount,
  }));
}
