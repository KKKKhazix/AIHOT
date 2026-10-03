// What an issue carries. A period carries its selected reports: public, not backfill, attributed by
// the later of arrival and release, and not released long after they happened. The daily is computed
// by rule, without a model judging anything: one entry per event, its most authoritative report with
// the event's other developments listed under it; an event an earlier issue covered comes back only
// with a new fact; an event with an official post and three or more independent participants is
// carried even when none of its reports was selected; entries rank by importance (score, the day's
// independent participants, first-hand), and the first one leads. Sections are the industry pack's
// (industry/taxonomy.ts CATEGORIES).
import { addDays } from "@aihot/contracts/time";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { sql } from "../db.ts";
import { currentSignals } from "../events/hot.ts";
import { pickRepresentative, representativePriority, REPRESENTATIVE_COLUMNS, type RepresentativeIdentity } from "../publication/representative.ts";
import { factSources } from "../publication/coverage.ts";
import { evidenceCondition, listedCondition, ownFactEvidenceCondition } from "../publication/scope.ts";

/** Each category's section; several categories may share one, in the order the pack lists them. */
export const SECTION_OF: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.section]));
export const SECTION_ORDER: readonly string[] = [...new Set(CATEGORIES.map((c) => c.section))];
/** An item without a category goes into the section of the industry category, else into the last one. */
const DEFAULT_SECTION = SECTION_OF.industry ?? SECTION_ORDER.at(-1)!;
export const sectionOf = (category: string | null) => SECTION_OF[category ?? ""] ?? DEFAULT_SECTION;

/** A daily's size: the entries readers get in full, and the one-line flashes after them. */
export const MAIN_ENTRIES = 12;
export const FLASH_ENTRIES = 10;
/** No source fills a daily: at most this many main entries lead with the same source. */
const PER_SOURCE = 2;
/** A follow-up of a covered event takes a full entry when this many sources carry its new facts. */
const FOLLOW_UP_SOURCES = 4;
/** The pack's `commentary` categories (how-tos, opinions): a follow-up of theirs is a flash, whoever wrote it. */
const COMMENTARY = new Set<string>(CATEGORIES.filter((c) => "commentary" in c).map((c) => c.key));
/** Earlier issues a daily remembers. */
const MEMORY_DAYS = 7;

export interface ReportEntry {
  itemId: string;
  factId: string | null;
  storyPublicId: string | null;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceId: string;
  firstParty: boolean;
  role: string;
  score: number | null;
  publishedAt: string;
}

export interface Candidate extends ReportEntry {
  category: string | null;
  factKey: string;
}

/** Another development of an entry's event, or a report of the launch it was merged with. */
export type RelatedReport = Pick<ReportEntry, "itemId" | "factId" | "storyPublicId" | "title" | "sourceName" | "sourceUrl" | "sourceId">;

/** One event of a daily as stored. */
export interface DailyEntry extends ReportEntry {
  /** Sources that reported the event by the cutoff, this one included. */
  sources: number;
  related?: RelatedReport[];
  /** The latest earlier issue that covered this event. */
  followUp?: string;
  /** Carried for its official post and independent coverage, though none of its reports was selected. */
  fillIn?: true;
}

/** An entry while its issue is edited: what ranking and the editors need besides what is stored. */
export interface EditionEntry {
  entry: DailyEntry;
  category: string | null;
  tags: string[];
  storyId: number | null;
  /** For an entry without an event of its own (a roundup): the events it mentions. */
  mentions: Set<number>;
  sourceIds: Set<string>;
  /** Representative priority: 0 for T1, 1–2 for verified official accounts and people. */
  authority: number;
  importance: number;
  /** The earlier issue's entry for this event, when there was one. */
  previous: { key: string; title: string } | null;
}

type ReportRow = RepresentativeIdentity & {
  id: string; title: string; summary: string | null; url: string; category: string | null; tags: string[]; score: number | null;
  first_party: boolean; body_mode: "full" | "summary"; timeline_at: Date;
  source_id: string; source_name: string; source_kind: string;
  fact_id: number | null; fact_public_id: string | null; story_id: number | null; story_public_id: string | null;
};

const REPORT_FIELDS = sql`p.article_id AS id, p.title, p.summary, p.url, p.category, p.tags, p.score, (s.tier = 'T1') AS first_party, p.body_mode, p.timeline_at,
  ${REPRESENTATIVE_COLUMNS}, s.id AS source_id, s.name AS source_name, s.kind AS source_kind,
  f.id AS fact_id, f.public_id AS fact_public_id, st.id AS story_id, st.public_id::text AS story_public_id`;

/**
 * The selected reports a period [start, end) carries. Each counts once, in the period readers first saw
 * it: by arrival, or by release when that came later (a release after the cutoff belongs to the next
 * issue, never to one already out). A report that arrived more than a day before the period began and
 * was released only within it is old news there.
 */
export async function periodReports(start: Date, end: Date): Promise<ReportRow[]> {
  return sql.begin("isolation level read committed", async (tx) => {
    // Wait for in-flight releases and keep later ones outside this snapshot. The following SELECT
    // gets a fresh READ COMMITTED snapshot; model calls and report writes happen after the lock ends.
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    return tx<ReportRow[]>`
      SELECT ${REPORT_FIELDS}
      FROM publications p JOIN sources s ON s.id = p.source_id
      LEFT JOIN facts f ON f.id = p.fact_id AND ${ownFactEvidenceCondition()}
      LEFT JOIN stories st ON st.id = f.story_id
      -- Attribute each item by the later of arrival and release; either range can use its index.
      WHERE p.visibility = 'public' AND p.selected AND NOT p.backfill
        AND (
          (p.visible_after <= p.timeline_at AND p.timeline_at >= ${start} AND p.timeline_at < ${end})
          OR (p.visible_after > p.timeline_at AND p.visible_after >= ${start} AND p.visible_after < ${end})
        )
        AND p.timeline_at >= ${start}::timestamptz - interval '24 hours'`;
  });
}

function roleOf(kind: string, official: boolean): string {
  if (official) return kind === "x_search" ? "X·官方" : "官方";
  if (kind === "x_search") return "X·KOL";
  if (kind === "mp_account") return "公众号";
  return "媒体";
}

function reportEntry(r: ReportRow): ReportEntry {
  return {
    itemId: r.id, factId: r.fact_public_id, storyPublicId: r.story_public_id, title: r.title, summary: r.summary ?? "",
    sourceName: r.source_name, sourceUrl: r.url, sourceId: r.source_id, firstParty: r.first_party,
    role: roleOf(r.source_kind, representativePriority(r) < 3), score: r.score, publishedAt: r.timeline_at.toISOString(),
  };
}

const asRelated = (e: ReportEntry): RelatedReport => ({
  itemId: e.itemId, factId: e.factId, storyPublicId: e.storyPublicId, title: e.title, sourceName: e.sourceName, sourceUrl: e.sourceUrl, sourceId: e.sourceId,
});

const factKeyOf = (r: ReportRow) => r.fact_public_id ?? `a:${r.id}`;

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
  return out;
}

/** A weekly's or monthly's candidates: each fact once, by its representative, best scored first. */
export async function candidates(start: Date, end: Date): Promise<Candidate[]> {
  const rows = await periodReports(start, end);
  return [...groupBy(rows, factKeyOf)]
    .map(([factKey, members]): Candidate => {
      const r = pickRepresentative(members);
      return { ...reportEntry(r), category: r.category, factKey };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * A weekly's or monthly's candidates, compiled from the dailies dated startDate…endDate: each event
 * once, by its most reported entry (then the first day's, the original news, then the most
 * authoritative) in the reports' current public wording, ranked by how the dailies treated it (lead,
 * highlight, the days it was carried), its coverage and its best score. Reports withdrawn since drop out.
 */
export async function periodEntries(startDate: string, endDate: string): Promise<{ entries: Candidate[]; issues: number }> {
  const issues = await sql<{ key: string; content: Record<string, any> }[]>`
    SELECT key, content FROM reports WHERE kind = 'daily' AND key >= ${startDate} AND key <= ${endDate} ORDER BY key`;
  const carried = issues.flatMap((issue) => (issue.content.sections ?? []).flatMap((s: any) => (s.items ?? []).filter((it: any) => it.itemId).map((it: any) => ({
    id: String(it.itemId),
    key: issue.key,
    sources: Number(it.sources) || 1,
    lead: issue.content.leadItemId === it.itemId,
    highlight: (issue.content.highlights ?? []).includes(it.itemId),
  }))));
  if (carried.length === 0) return { entries: [], issues: issues.length };
  const rows = await sql<ReportRow[]>`
    SELECT ${REPORT_FIELDS}
    FROM publications p JOIN sources s ON s.id = p.source_id
    LEFT JOIN facts f ON f.id = p.fact_id AND ${ownFactEvidenceCondition()}
    LEFT JOIN stories st ON st.id = f.story_id
    WHERE p.article_id = ANY(${[...new Set(carried.map((c) => c.id))]}::text[]) AND p.visibility = 'public' AND p.eligible`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const events = groupBy(carried.filter((c) => byId.has(c.id)), (c) => {
    const r = byId.get(c.id)!;
    return r.story_id === null ? `a:${r.id}` : `s:${r.story_id}`;
  });
  const ranked = [...events.values()].map((cs) => {
    const authority = (c: { id: string }) => representativePriority(byId.get(c.id)!);
    const main = byId.get([...cs].sort((a, b) => b.sources - a.sources || a.key.localeCompare(b.key) || authority(a) - authority(b))[0]!.id)!;
    const rank = Math.max(...cs.map((c) => byId.get(c.id)!.score ?? 0)) + 5 * Math.log2(1 + Math.max(...cs.map((c) => c.sources)))
      + (cs.some((c) => c.lead) ? 6 : 0) + (cs.some((c) => c.highlight) ? 3 : 0) + 4 * (new Set(cs.map((c) => c.key)).size - 1);
    return { candidate: { ...reportEntry(main), category: main.category, factKey: factKeyOf(main) }, rank };
  });
  ranked.sort((a, b) => b.rank - a.rank || a.candidate.itemId.localeCompare(b.candidate.itemId));
  return { entries: ranked.map((r) => r.candidate), issues: issues.length };
}

/** Every report an issue cites: its entries, what is listed under them, its flashes. */
export function citedIn(content: Record<string, any>): Array<Record<string, any>> {
  const entries = [...(content.sections ?? []).flatMap((s: any) => s.items ?? []), ...(content.flashes ?? [])];
  return [...entries, ...entries.flatMap((e: any) => e.related ?? [])];
}

/**
 * What the issues of the week before `date` carried: their facts and reports, which are not repeated,
 * and their events with the latest issue and headline that covered each. Facts and events are also
 * read from the cited reports' current grouping, so a later merge or regrouping still counts.
 */
export async function dailyMemory(date: string): Promise<{ keys: Set<string>; stories: Map<number, { key: string; title: string }> }> {
  const issues = await sql<{ key: string; content: Record<string, any> }[]>`
    SELECT key, content FROM reports WHERE kind = 'daily' AND key < ${date} AND key >= ${addDays(date, -MEMORY_DAYS)} ORDER BY key DESC`;
  const keys = new Set<string>();
  const cited = new Map<string, { key: string; title: string }>();
  for (const issue of issues) {
    for (const it of citedIn(issue.content)) {
      if (it.factId) keys.add(String(it.factId));
      if (!it.itemId) continue;
      keys.add(`a:${it.itemId}`);
      if (!cited.has(it.itemId)) cited.set(it.itemId, { key: issue.key, title: String(it.title ?? "") });
    }
  }
  const stories = new Map<number, { key: string; title: string }>();
  if (cited.size === 0) return { keys, stories };
  const current = await sql<{ id: string; fact_public_id: string | null; story_id: number | null }[]>`
    SELECT p.article_id AS id, f.public_id AS fact_public_id, f.story_id FROM publications p
    LEFT JOIN facts f ON f.id = p.fact_id AND ${ownFactEvidenceCondition()}
    WHERE p.article_id = ANY(${[...cited.keys()]}::text[])`;
  for (const c of current) {
    if (c.fact_public_id) keys.add(c.fact_public_id);
    if (c.story_id === null) continue;
    const at = cited.get(c.id)!;
    const seen = stories.get(c.story_id);
    if (!seen || seen.key < at.key) stories.set(c.story_id, at);
  }
  return { keys, stories };
}

/**
 * Facts the selection missed although the event is clearly news: no selected report, three or more
 * independent participants by the cutoff (as the heat counts them), an official post among its reports,
 * active in the window and begun at most a day before it. Each comes with its listed editorial reports,
 * from which the issue takes the most authoritative one.
 */
async function missedFacts(start: Date, end: Date): Promise<Array<{ key: string; rows: ReportRow[] }>> {
  const found = await sql<{ fact_id: number }[]>`
    WITH active AS (
      SELECT DISTINCT fa.fact_id FROM fact_articles fa
      JOIN publications p ON p.article_id = fa.article_id JOIN sources s ON s.id = p.source_id
      WHERE ${evidenceCondition()} AND ${listedCondition(end)} AND s.participation_mode = 'editorial' AND NOT p.backfill
        AND p.timeline_at >= ${start} AND p.timeline_at < ${end}
    )
    SELECT fa.fact_id
    FROM active JOIN fact_articles fa ON fa.fact_id = active.fact_id
    JOIN publications p ON p.article_id = fa.article_id
    JOIN ${currentSignals()} cs ON cs.article_id = fa.article_id
    WHERE ${evidenceCondition()} AND cs.observed_at < ${end}
      AND NOT EXISTS (SELECT 1 FROM fact_articles sfa JOIN publications sp ON sp.article_id = sfa.article_id
                      WHERE sfa.fact_id = fa.fact_id AND sfa.role <> 'mention' AND sp.selected AND sp.visibility = 'public')
    GROUP BY fa.fact_id
    HAVING count(DISTINCT cs.participant_key) >= 3 AND min(cs.observed_at) >= ${start}::timestamptz - interval '24 hours'`;
  if (found.length === 0) return [];
  const rows = await sql<ReportRow[]>`
    SELECT ${REPORT_FIELDS}
    FROM fact_articles fa JOIN publications p ON p.article_id = fa.article_id JOIN sources s ON s.id = p.source_id
    JOIN facts f ON f.id = fa.fact_id LEFT JOIN stories st ON st.id = f.story_id
    WHERE fa.fact_id = ANY(${found.map((f) => f.fact_id)}::bigint[]) AND ${evidenceCondition()} AND ${listedCondition(end)}
      AND s.participation_mode = 'editorial' AND s.tier <> 'EXCLUDE_MP' AND NOT p.backfill AND p.timeline_at < ${end}`;
  return [...groupBy(rows, factKeyOf)]
    .filter(([, members]) => members.some((r) => representativePriority(r) < 3))
    .map(([key, members]) => ({ key, rows: members }));
}

/**
 * How much an event matters to a reader of the day: the best score among its selected reports, its
 * heat as the independent participants who discussed it within the issue's window (as the hot list
 * counts them: 1 → 5, 3 → 10, 7 → 15, 15 → 20), a first-hand post, and less for an event an earlier
 * issue already covered.
 */
function importance(e: { score: number | null; participants: number; official: boolean; followUp: boolean }): number {
  return (e.score ?? 50) + 5 * Math.log2(1 + e.participants) + (e.official ? 5 : 0) - (e.followUp ? 6 : 0);
}

interface Fact { key: string; rows: ReportRow[]; selected: boolean; sources: string[]; at: number }

/**
 * The daily's events for the window [start, end), most important first, before the editors' pass:
 * selected reports and missed facts, minus what the week's issues already carried, one entry per event.
 */
export async function dailyEdition(date: string, start: Date, end: Date): Promise<{ entries: EditionEntry[]; stats: Record<string, number> }> {
  const [memory, selected, missed] = await Promise.all([dailyMemory(date), periodReports(start, end), missedFacts(start, end)]);
  const raw = [
    ...[...groupBy(selected, factKeyOf)].map(([key, rows]) => ({ key, rows, selected: true })),
    ...missed.map((m) => ({ ...m, selected: false })),
  ];
  const kept = raw.filter((f) => !memory.keys.has(f.key) && !f.rows.some((r) => memory.keys.has(`a:${r.id}`)));
  const factIds = [...new Set(kept.map((f) => f.rows[0]!.fact_id).filter((id): id is number => id !== null))];
  const sourcesOf = await factSources(factIds, end);
  const facts: Fact[] = kept.map((f) => {
    const id = f.rows[0]!.fact_id;
    return {
      ...f,
      sources: [...new Set([...(id === null ? [] : sourcesOf.get(id) ?? []), ...f.rows.map((r) => r.source_id)])],
      at: Math.min(...f.rows.map((r) => r.timeline_at.getTime())),
    };
  });

  // One entry per event: its most reported fact leads (then the earliest, as the hot list chooses), and
  // the event's other facts are listed under it.
  const events = [...groupBy(facts, (f) => (f.rows[0]!.story_id === null ? `f:${f.key}` : `s:${f.rows[0]!.story_id}`)).values()];
  const storyIds = [...new Set(events.map((fs) => fs[0]!.rows[0]!.story_id).filter((id): id is number => id !== null))];
  const loose = events.filter((fs) => fs[0]!.rows[0]!.story_id === null).flatMap((fs) => fs.flatMap((f) => f.rows.map((r) => r.id)));
  const [talk, named] = await Promise.all([
    storyIds.length
      ? sql<{ story_id: number; participants: number }[]>`
        SELECT cs.story_id, count(DISTINCT cs.participant_key)::int AS participants FROM ${currentSignals()} cs
        WHERE cs.story_id = ANY(${storyIds}::bigint[]) AND cs.observed_at >= ${start} AND cs.observed_at < ${end}
        GROUP BY cs.story_id`
      : [],
    // A report without an event of its own is a roundup when the event graph linked it to the facts it mentions.
    loose.length
      ? sql<{ article_id: string; story_id: number }[]>`
        SELECT DISTINCT fa.article_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
        WHERE fa.article_id = ANY(${loose}::text[]) AND f.story_id IS NOT NULL`
      : [],
  ]);
  const participants = new Map(talk.map((t) => [t.story_id, t.participants]));

  const entries = events.map((fs): EditionEntry => {
    const ordered = [...fs].sort((a, b) => b.sources.length - a.sources.length || a.at - b.at || a.key.localeCompare(b.key));
    const reps = ordered.map((f) => pickRepresentative(f.rows));
    const rep = reps[0]!;
    const sourceIds = new Set(fs.flatMap((f) => f.sources));
    const storyId = rep.story_id;
    const previous = storyId === null ? null : memory.stories.get(storyId) ?? null;
    const score = Math.max(rep.score ?? 0, ...fs.filter((f) => f.selected).flatMap((f) => f.rows.map((r) => r.score ?? 0)));
    const entry: DailyEntry = {
      ...reportEntry(rep),
      sources: sourceIds.size,
      ...(reps.length > 1 ? { related: reps.slice(1).map((r) => asRelated(reportEntry(r))) } : {}),
      ...(previous ? { followUp: previous.key } : {}),
      ...(fs.every((f) => !f.selected) ? { fillIn: true as const } : {}),
    };
    const ids = new Set(fs.flatMap((f) => f.rows.map((r) => r.id)));
    return {
      entry, category: rep.category, tags: rep.tags, storyId, sourceIds, authority: representativePriority(rep), previous,
      mentions: new Set(storyId === null ? named.filter((n) => ids.has(n.article_id)).map((n) => n.story_id) : []),
      importance: importance({
        score,
        participants: storyId === null ? sourceIds.size : participants.get(storyId) ?? sourceIds.size,
        official: fs.some((f) => f.rows.some((r) => representativePriority(r) < 3)),
        followUp: !!previous,
      }),
    };
  });
  entries.sort((a, b) => b.importance - a.importance || a.entry.itemId.localeCompare(b.entry.itemId));
  return {
    entries,
    stats: { selectedReports: selected.length, facts: raw.length, repeatsSuppressed: raw.length - kept.length, fillIns: kept.filter((f) => !f.selected).length, events: entries.length },
  };
}

/**
 * The issue from the ranked entries, by rule: a roundup that mentions events of this issue is listed
 * under the most important of them; a follow-up of a covered event takes a full entry only when the
 * party itself acted (not as commentary) or four or more sources carry its new facts, else it is a flash;
 * then the most important entries in full, at most two per source, and the next ones as flashes. The
 * first entry leads the issue and the next three are its highlights.
 */
export function arrangeDaily(entries: EditionEntry[]): { main: EditionEntry[]; flashes: EditionEntry[]; stats: Record<string, number> } {
  const byStory = new Map(entries.filter((e) => e.storyId !== null).map((e) => [e.storyId!, e]));
  const under = new Map<EditionEntry, EditionEntry[]>();
  for (const e of entries) {
    const named = [...e.mentions].map((id) => byStory.get(id)).filter((h): h is EditionEntry => !!h);
    if (named.length === 0) continue;
    const host = named.reduce((a, b) => (b.importance > a.importance ? b : a));
    under.set(host, [...(under.get(host) ?? []), e]);
  }
  const folded = new Set([...under.values()].flat());
  const live = entries.filter((e) => !folded.has(e)).map((e): EditionEntry => {
    const roundups = under.get(e);
    if (!roundups) return e;
    const sourceIds = new Set([...e.sourceIds, ...roundups.flatMap((r) => [...r.sourceIds])]);
    const related = [...(e.entry.related ?? []), ...roundups.flatMap((r) => [asRelated(r.entry), ...(r.entry.related ?? [])])];
    return { ...e, sourceIds, entry: { ...e.entry, sources: sourceIds.size, related } };
  });
  const earned = (e: EditionEntry) => !e.previous || (e.authority < 3 && !COMMENTARY.has(e.category ?? "")) || e.entry.sources >= FOLLOW_UP_SOURCES;
  // A day of nothing but follow-ups still has entries in full.
  const full = live.some(earned) ? earned : () => true;
  const main: EditionEntry[] = [];
  const rest: EditionEntry[] = [];
  const perSource = new Map<string, number>();
  for (const e of live) {
    const n = perSource.get(e.entry.sourceId) ?? 0;
    if (main.length < MAIN_ENTRIES && n < PER_SOURCE && full(e)) {
      main.push(e);
      perSource.set(e.entry.sourceId, n + 1);
    } else rest.push(e);
  }
  const flashes = rest.slice(0, FLASH_ENTRIES);
  return { main, flashes, stats: { roundupsFolded: folded.size, followUpsAsFlashes: live.filter((e) => !full(e)).length, left: rest.length - flashes.length } };
}
