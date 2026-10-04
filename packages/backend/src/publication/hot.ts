// The latest hot ranking through the public read layer. A stored entry is shown only while its
// representative is still listed evidence of the story (regrouping or a withdrawal can undo it before
// the next ranking); the web shows heat values, machine exits only ranks (stories.ts).
import { HOT_FACE_LIMIT, type HotParticipant, type HotStripEntry } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { storedHotRanking, tierRank, type HotEntry, type HotRanking } from "../events/hot.ts";
import { cached, cachedByKey, SHARED_ONLY } from "../lib/cache.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { publicSourceName } from "./rules.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";
import { storyTexts } from "./story-text.ts";

// Concurrent reads are shared, nothing more: public words follow withdrawals and regrouping at once.
const ranking = cached(queryLatestHotRanking, SHARED_ONLY);

export function latestHotRanking(): Promise<HotRanking | null> {
  return ranking.get();
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
    WHERE f.story_id IN ${sql(entries.map((entry) => entry.storyId))} AND p.article_id IN ${sql(entries.map((entry) => entry.representativeItemId ?? ""))}
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

interface Extras {
  faces: Map<string, string | null>;
  texts: Map<number, { summary: string | null; latest: string | null }>;
}

const readExtras = cachedByKey((ranking: HotRanking) => String(ranking.id), queryExtras, { ...SHARED_ONLY, maxKeys: 4 });

async function queryExtras(ranking: HotRanking): Promise<Extras> {
  const ids = ranking.entries.map((e) => e.storyId);
  const [faces, texts] = await Promise.all([
    // A participant's face: the source's icon, else the avatar on that account's latest post in the story.
    sql<{ name: string; icon_url: string | null; avatar: string | null }[]>`
      SELECT DISTINCT ON (s.id) s.name, s.icon_url, a.x_post->>'avatarUrl' AS avatar
      FROM story_signals ss JOIN sources s ON s.id = ss.source_id
      LEFT JOIN articles a ON a.id = ss.article_id AND a.x_post ? 'avatarUrl'
      WHERE ss.story_id = ANY(${ids}::bigint[])
      ORDER BY s.id, (a.id IS NULL), a.discovered_at DESC, a.id DESC`,
    storyTexts(ids),
  ]);
  return {
    faces: new Map(faces.map((f) => [f.name, f.icon_url ?? f.avatar])),
    texts: new Map([...texts].map(([id, t]) => [id, { summary: t.digest ?? t.summary, latest: t.latest?.title ?? null }])),
  };
}

/**
 * What the web adds to a ranking entry: participants with proxied faces in the order Faces shows them
 * (精选组 by tier, a real face before an initial within a tier, then 氛围组), the digest and the latest turn.
 */
export async function rankingExtras(ranking: HotRanking) {
  const { faces, texts } = await readExtras(ranking);
  return {
    participants: (e: HotEntry): HotParticipant[] => {
      const people = e.participants
        .map((p, i) => ({ p, i, icon: faces.get(p.name) ?? null }))
        .sort((x, y) => Number(y.p.kind === "editorial") - Number(x.p.kind === "editorial") || tierRank(x.p.tier) - tierRank(y.p.tier) || Number(!!y.icon) - Number(!!x.icon) || x.i - y.i);
      // A publisher's blog and its X account share a public name: listed once, with the first face.
      const named = new Map<string, (typeof people)[number]>();
      for (const person of people) {
        const name = publicSourceName(person.p.name);
        if (!named.has(name)) named.set(name, person);
      }
      // Every name stays for the tooltip; only visible faces carry image URLs.
      return [...named].map(([name, { p, icon }], i): HotParticipant => {
        const person: HotParticipant = { name, kind: p.kind };
        if (p.kind === "editorial" && i < HOT_FACE_LIMIT) {
          person.iconUrl = proxiedImage(icon, "avatar");
          const srcSet = proxiedImageSet(icon, "avatar");
          if (srcSet) person.iconSrcSet = srcSet;
        }
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
