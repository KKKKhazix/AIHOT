// The latest hot ranking through the public read layer. A stored entry is shown only while its
// representative is still listed evidence of the story (regrouping or a withdrawal can undo it before
// the next ranking); the web shows heat values, machine exits only ranks (stories.ts).
import { HOT_FACE_LIMIT, type HotParticipant, type HotStripEntry } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { storedHotRanking, tierRank, type HotEntry, type HotRanking } from "../events/hot.ts";
import { shared } from "../lib/cache.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { publicSourceName } from "./rules.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";

// Concurrent reads are shared, nothing more: public words follow withdrawals and regrouping at once.
const ranking = shared<void, HotRanking | null>(() => "latest", queryLatestHotRanking);

export function latestHotRanking(): Promise<HotRanking | null> {
  return ranking();
}

/** Search links follow the same current public evidence as every hot-ranking surface. */
export async function hotSearchLinks() {
  const ranking = await latestHotRanking();
  return (ranking?.entries ?? []).slice(0, 5).map(e => ({ rank: e.rank, title: e.title, to: `/story/${e.storyPublicId}` }));
}

async function queryLatestHotRanking(): Promise<HotRanking | null> {
  const row = await storedHotRanking();
  if (!row) return null;
  const now = new Date();
  const entries = row.entries;
  const current = entries.length ? await sql<{ story_id: number; article_id: string; story_title: string; url: string; source_name: string; latest_at: Date }[]>`
    SELECT DISTINCT ON (f.story_id, p.article_id) f.story_id, p.article_id, st.title AS story_title, p.url, s.name AS source_name,
      latest.at AS latest_at
    FROM facts f JOIN stories st ON st.id = f.story_id JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    JOIN LATERAL (
      SELECT max(coalesce(p.published_at, p.discovered_at)) AS at
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = st.id AND ${evidenceCondition()} AND ${listedCondition(now)}
    ) latest ON true
    WHERE f.story_id IN ${sql(entries.map((entry) => entry.storyId))} AND st.merged_into IS NULL AND p.article_id IN ${sql(entries.map((entry) => entry.representativeItemId ?? ""))}
      AND ${evidenceCondition()} AND ${listedCondition(now)}
    ORDER BY f.story_id, p.article_id, (fa.role = 'primary') DESC, f.id` : [];
  const valid = new Map(current.map((report) => [`${report.story_id}:${report.article_id}`, report]));
  // Regrouping can invalidate a saved representative before the next heat refresh. Do not link the
  // event to a report it no longer holds; the next normal ranking can choose its replacement.
  const visible = entries.flatMap((entry) => {
    const report = valid.get(`${entry.storyId}:${entry.representativeItemId}`);
    return report ? [{ ...entry, title: report.story_title, latestAt: report.latest_at.toISOString(), representativeUrl: report.url, representativeSource: report.source_name }] : [];
  });
  return { ...row, entries: visible };
}

/** Participants' public names and faces across the whole ranking, shared by the home strip and the hot page. */
export const rankingParticipants = shared((ranking: HotRanking) => String(ranking.id), queryRankingParticipants);

async function queryRankingParticipants(ranking: HotRanking) {
  const ids = ranking.entries.map((e) => e.storyId);
  // A participant's face: the source's icon, else the avatar on that account's latest post in the story.
  // A null lookup key skips the article read; an ON guard can still fetch it before filtering.
  const faces = await sql<{ id: string; name: string; icon_url: string | null; avatar: string | null }[]>`
    SELECT DISTINCT ON (s.id) s.id, s.name, s.icon_url, a.x_post->>'avatarUrl' AS avatar
    FROM story_signals ss JOIN sources s ON s.id = ss.source_id
    LEFT JOIN articles a ON a.id = CASE WHEN s.icon_url IS NULL THEN ss.article_id END AND a.x_post ? 'avatarUrl'
      AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id AND (p.suppress_original OR p.visibility <> 'public'))
    WHERE ss.story_id = ANY(${ids}::bigint[])
    ORDER BY s.id, (a.id IS NULL), a.discovered_at DESC, a.id DESC`;
  const facesById = new Map(faces.map((f) => [f.id, { name: f.name, icon: f.icon_url ?? f.avatar }]));
  return (e: HotEntry): HotParticipant[] => {
    const people = e.participants
      .map((p, i) => {
        const live = facesById.get(p.sourceId);
        return { p, i, name: live?.name ?? p.name, icon: live?.icon ?? null };
      })
      .sort((x, y) => Number(y.p.kind === "editorial") - Number(x.p.kind === "editorial") || tierRank(x.p.tier) - tierRank(y.p.tier) || Number(!!y.icon) - Number(!!x.icon) || x.i - y.i);
    // A publisher's blog and its X account share a public name: listed once, with the first face.
    const named = new Map<string, (typeof people)[number]>();
    for (const person of people) {
      const name = publicSourceName(person.name);
      if (!named.has(name)) named.set(name, person);
    }
    // Every name stays for the tooltip; only visible faces carry image URLs.
    return [...named].map(([name, { p, icon }], i): HotParticipant => {
      const person: HotParticipant = { sourceId: p.sourceId, name, kind: p.kind };
      if (p.kind === "editorial" && i < HOT_FACE_LIMIT) {
        person.iconUrl = proxiedImage(icon, "avatar");
        const srcSet = proxiedImageSet(icon, "avatar");
        if (srcSet) person.iconSrcSet = srcSet;
      }
      return person;
    });
  };
}

/** Home "current hot" strip: 3–5 entries from the same ranking, hidden when there are fewer than 3. */
export async function loadHotStrip(): Promise<HotStripEntry[] | null> {
  const ranking = await latestHotRanking();
  if (!ranking || ranking.entries.length < 3) return null;
  const participants = await rankingParticipants(ranking);
  return ranking.entries.slice(0, 5).map((e) => ({
    rank: e.rank,
    title: e.title,
    heat: e.heat,
    trend: e.trend,
    storyPublicId: e.storyPublicId,
    itemId: e.representativeItemId,
    participants: participants(e),
    participantCount: e.participantCount,
  }));
}
