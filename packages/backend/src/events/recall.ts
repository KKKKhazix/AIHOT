// Candidate recall for grouping (group.ts): the reports of the last RECALL_DAYS days that belong to a
// live fact, compared with the report being decided by the same title-and-summary embedding on both
// sides (without an embedding key, by their shared character bigrams), plus the same URL and the X
// post it replies to or quotes. A membership counts as evidence only when its report is not a
// composite or explicitly withdrawn (groupingEvidenceCondition). Selected reports are reading context
// for READING_DAYS: a reader who saw a launch in 精选 still knows it when its maker introduces it again.
// A discussion post is also compared with the posts already attached to a fact that still count for
// its heat (recallFactsByPosts): posts about one happening paraphrase each other more closely than
// they paraphrase its reports.
import { sql } from "../db.ts";
import { beijingDate } from "@aihot/contracts/time";
import { sha256 } from "../lib/ids.ts";
import { embeddingsAvailable, ensureEmbeddings } from "../providers/embeddings.ts";
import { GROUP_BODY_CHARS, lexicalSimilarity, reportText, signalText, type CandidateView, type ReportView, type ReadingContext } from "./relate.ts";
import { groupingEvidenceCondition, ownFactEvidenceCondition, selectedCondition } from "../publication/scope.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeIdentity, type RepresentativeRow } from "../publication/representative.ts";

/** Reports discovered this recently are candidates (keyed on discovery, so an old page found today still meets its peers). */
export const RECALL_DAYS = 14;
/** Selected reports stay reader coverage this long (an official re-introduction can come weeks after a launch). */
export const READING_DAYS = 60;

export interface PoolRow {
  article_id: string;
  fact_id: number;
  story_id: number;
  fact_title: string;
  revision?: number;
}

export interface Recalled {
  factId: number;
  storyId: number;
  factTitle: string;
  score: number;
}

/**
 * The fact that starts a story for a later identity decision: the earliest eligible report,
 * excluding composites and withdrawals. Fact ids do not follow time after a merge or an import;
 * a fact without eligible reports starts nothing.
 */
export const rootFactOf = (story: ReturnType<typeof sql> | number) => sql`(
  SELECT y.id FROM facts y
  JOIN fact_articles z ON z.fact_id = y.id AND z.role IN ('primary', 'report') AND ${groupingEvidenceCondition(sql`z.article_id`)}
  JOIN publications q ON q.article_id = z.article_id
  WHERE y.story_id = ${story}
  ORDER BY coalesce(q.published_at, q.discovered_at), y.id
  LIMIT 1)`;

/** Reports of the recall window that belong to a live fact. */
async function recallPool(): Promise<PoolRow[]> {
  // Correlate the analysis lookup with articles so its discovery window is applied first.
  return sql<PoolRow[]>`
    SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title, coalesce(p.revision, 0) AS revision
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    JOIN articles a ON a.id = fa.article_id
    LEFT JOIN publications p ON p.article_id = a.id
    WHERE fa.role IN ('primary', 'report') AND ${groupingEvidenceCondition(sql`a.id`)} AND a.discovered_at > now() - make_interval(days => ${RECALL_DAYS})`;
}

/**
 * Discussion posts attached to a live fact (the one their attaching decision named) whose source time
 * is within the last `hours`, from sources that are discussion evidence now. A post an editor placed
 * is a report of the fact they chose (recallPool), never evidence of the one the model picked.
 */
async function attachedPostsPool(hours: number): Promise<PoolRow[]> {
  return sql<PoolRow[]>`
    SELECT ss.article_id, f.id AS fact_id, f.story_id, f.title AS fact_title, a.revision
    FROM story_signals ss
    JOIN articles a ON a.id = ss.article_id
    JOIN sources s ON s.id = a.source_id AND s.participation_mode = 'hot_signal'
    JOIN LATERAL (SELECT d.fact_id FROM grouping_decisions d
                  WHERE d.article_id = ss.article_id AND d.verdict IN ('signal', 'signal-native') ORDER BY d.id DESC LIMIT 1) d ON true
    JOIN facts f ON f.id = d.fact_id AND f.story_id = ss.story_id
    JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    WHERE ss.observed_at > now() - make_interval(hours => ${hours}) AND ${groupingEvidenceCondition(sql`ss.article_id`)}
      AND NOT EXISTS (SELECT 1 FROM fact_articles m WHERE m.article_id = ss.article_id AND m.manual)`;
}

type ReadingRow = ReportView & { article_id: string; revision: number; fact_id: number | null };

/**
 * Already displayed reports supply reading context, never identity evidence: those without a fact,
 * and, past the recall window, those whose fact is not an identity candidate (shown there already).
 */
async function selectedReadingPool(candidateFacts: number[]): Promise<ReadingRow[]> {
  return sql<ReadingRow[]>`
    SELECT p.article_id, p.revision, p.fact_id, p.title, p.summary, s.name AS source, (s.tier = 'T1') AS "firstParty",
      p.published_at AS at, a.publication_time AS "publicationTime", an.output->>'scope' AS scope
    FROM publications p JOIN articles a ON a.id = p.article_id JOIN sources s ON s.id = p.source_id LEFT JOIN analyses an ON an.id = p.analysis_id
    WHERE ${selectedCondition(new Date())} AND p.discovered_at > now() - make_interval(days => ${READING_DAYS})
      AND (p.fact_id IS NULL OR (p.discovered_at <= now() - make_interval(days => ${RECALL_DAYS}) AND NOT p.fact_id = ANY(${candidateFacts}::bigint[])))`;
}

/** The public title and summary of reports (the analysis when a report has no publication yet). */
async function reportTexts(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; title: string; summary: string | null }[]>`
    SELECT a.id, coalesce(p.title, an.title_zh, a.title) AS title, coalesce(p.summary, an.summary_zh, '') AS summary
    FROM articles a
    LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN LATERAL (SELECT title_zh, summary_zh FROM analyses x WHERE x.article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
    WHERE a.id = ANY(${ids})`;
  return new Map(rows.map((r) => [r.id, reportText(r.title, r.summary)]));
}

/** The texts of discussion posts (signalText). */
async function postTexts(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; title: string; body_text: string | null }[]>`
    SELECT id, title, left(body_text, 300) AS body_text FROM articles WHERE id = ANY(${ids})`;
  return new Map(rows.map((r) => [r.id, signalText(r)]));
}

// Vectors of the recall window stay in the worker process; only new or changed texts are embedded
// (and stored) again. Grouping is serial, so one process holds the whole window. They are kept as
// Float32Array, the precision the embeddings table stores (real[]), so a vector straight from the
// provider and the same vector read back later give the same cosine.
const vectorCache = new Map<string, { hash: string; vector: Float32Array; revision?: number }>();

export async function vectorsFor(items: Array<{ id: string; text: string; revision?: number }>): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: Array<{ id: string; text: string; hash: string; revision?: number }> = [];
  for (const it of items) {
    const hash = sha256(it.text);
    const cached = vectorCache.get(it.id);
    if (cached && cached.hash === hash) {
      if (it.revision !== undefined) cached.revision = it.revision;
      out.set(it.id, cached.vector);
    } else missing.push({ ...it, hash });
  }
  if (missing.length) {
    const got = await ensureEmbeddings(missing.map((m) => ({ id: m.id, text: m.text })));
    for (const m of missing) {
      const v = got.get(m.id);
      if (!v) continue;
      const vector = Float32Array.from(v);
      vectorCache.set(m.id, { hash: m.hash, vector, revision: m.revision });
      out.set(m.id, vector);
    }
  }
  if (vectorCache.size > 30_000) vectorCache.clear();
  return out;
}

export function cosine32(a: Float32Array, b: Float32Array): number {
  // Vectors of different sizes (EMBEDDING_DIMS changed, or left to the provider) are not comparable.
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The lexical fallback's bar: shared bigrams are not on the cosine scale, so it has its own. */
const LEXICAL_MIN = 0.25;

/** Both identity candidates and reading context use the same stored vectors (or the lexical fallback). */
async function similarReports(queryId: string, queryText: string, pool: Array<{ article_id: string; revision?: number }>, minScore: number,
  texts: (ids: string[]) => Promise<Map<string, string>> = reportTexts): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (pool.length && !embeddingsAvailable()) {
    for (const [id, text] of await texts([...new Set(pool.map((r) => r.article_id))])) {
      const s = lexicalSimilarity(queryText, text);
      if (s >= LEXICAL_MIN) scores.set(id, s);
    }
    return scores;
  }
  if (pool.length) {
    // Publication revisions invalidate changed reports without fetching every cached text. The
    // text hash still avoids paying again when a revision changed only non-text public fields.
    const ids = [...new Set(pool.map((r) => r.article_id))];
    const revisions = new Map(pool.map((r) => [r.article_id, r.revision]));
    // Keep this call's hits even if loading new vectors clears the process cache.
    const cached = new Map<string, Float32Array>();
    const uncached = ids.filter((id) => {
      const hit = vectorCache.get(id);
      if (!hit || hit.revision !== revisions.get(id)) return true;
      cached.set(id, hit.vector);
      return false;
    });
    const uncachedTexts = await texts(uncached);
    const fresh = await vectorsFor([{ id: queryId, text: queryText }, ...uncached.map((id) => ({ id, text: uncachedTexts.get(id) ?? "", revision: revisions.get(id) })).filter((x) => x.text)]);
    const mine = fresh.get(queryId);
    if (mine) {
      for (const r of pool) {
        const v = fresh.get(r.article_id) ?? cached.get(r.article_id);
        if (!v) continue;
        const s = cosine32(mine, v);
        if (s >= minScore) scores.set(r.article_id, s);
      }
    }
  }
  return scores;
}

/** The best report of each fact counts; boosted facts (quoted/replied-to posts) are always included. */
export async function recallFacts(queryId: string, queryText: string, minScore: number, top: number, boost: PoolRow[] = []): Promise<Recalled[]> {
  const pool = (await recallPool()).filter((r) => r.article_id !== queryId);
  const scores = await similarReports(queryId, queryText, pool, minScore);
  return bestPerFact([...scoredRows(pool, scores), ...boost.map((r) => toRecalled(r, 1))], top);
}

/** The facts the discussion posts attached within the last `hours` point to; the closest post of each fact counts. */
export async function recallFactsByPosts(queryId: string, queryText: string, minScore: number, hours: number): Promise<Recalled[]> {
  const pool = (await attachedPostsPool(hours)).filter((r) => r.article_id !== queryId);
  return bestPerFact(scoredRows(pool, await similarReports(queryId, queryText, pool, minScore, postTexts)));
}

/** Each fact once, at its best score, most similar first. */
export function bestPerFact(items: Recalled[], top = Infinity): Recalled[] {
  const best = new Map<number, Recalled>();
  for (const it of items) {
    const prev = best.get(it.factId);
    if (!prev || it.score > prev.score) best.set(it.factId, it);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, top);
}

function toRecalled(r: PoolRow, score: number): Recalled {
  return { factId: r.fact_id, storyId: r.story_id, factTitle: r.fact_title, score };
}

function scoredRows(pool: PoolRow[], scores: Map<string, number>): Recalled[] {
  return pool.flatMap((r) => (scores.has(r.article_id) ? [toRecalled(r, scores.get(r.article_id)!)] : []));
}

/** A small separate context lets a single report compare with earlier selected coverage, one report per fact. */
export async function recallSelectedBackground(queryId: string, queryText: string, minScore: number, candidateFacts: number[] = [], top = 3): Promise<ReadingContext[]> {
  const pool = (await selectedReadingPool(candidateFacts)).filter(r => r.article_id !== queryId);
  const scores = await similarReports(queryId, queryText, pool, minScore);
  const picked: ReadingRow[] = [];
  const facts = new Set<number>();
  for (const r of pool.filter(r => scores.has(r.article_id)).sort((a, b) => scores.get(b.article_id)! - scores.get(a.article_id)!)) {
    if (picked.length === Math.min(top, 3)) break;
    const fact = r.fact_id === null ? null : Number(r.fact_id);
    if (fact !== null && facts.has(fact)) continue;
    if (fact !== null) facts.add(fact);
    picked.push(r);
  }
  if (!picked.length) return [];
  // Read only the saved text of the few matching reports; never fetch or extract for this comparison.
  const bodies = new Map((await sql<{ id: string; text: string | null }[]>`
    SELECT id, left(body_text, ${GROUP_BODY_CHARS}) AS text FROM articles WHERE id = ANY(${picked.map(r => r.article_id)})`
  ).map(r => [r.id, r.text]));
  return picked.map(({ article_id, revision, fact_id, ...report }) => ({ report, sourceText: bodies.get(article_id) ?? null }));
}

/**
 * What the judge sees of a candidate fact: its representative report (first-party first, else the
 * earliest), its size, and whether it started its story (rootFactOf).
 */
export async function candidateViews(recalled: Recalled[]): Promise<CandidateView[]> {
  if (recalled.length === 0) return [];
  const ids = recalled.map((r) => r.factId);
  type SelectedRow = RepresentativeRow & RepresentativeIdentity & {
    fact_id: number; title: string; summary: string | null; source: string; first_party: boolean; at: Date | null; publicationTime: string | null;
  };
  const [rows, selectedRows] = await Promise.all([sql<{
    fact_id: number; story_id: number; fact_title: string; subject: string | null; action: string | null; object: string | null; occurred_at: Date | null;
    title: string; summary: string | null; source: string; first_party: boolean; at: Date | null; publicationTime: string | null; members: number; root_fact_id: number;
  }[]>`
    SELECT DISTINCT ON (fa.fact_id) fa.fact_id, f.story_id, f.title AS fact_title, f.subject, f.action, f.object, f.occurred_at,
           p.title, p.summary, s.name AS source, (s.tier = 'T1') AS first_party, p.published_at AS at, a.publication_time AS "publicationTime",
           (SELECT count(*) FROM fact_articles x WHERE x.fact_id = fa.fact_id AND x.role IN ('primary', 'report') AND ${groupingEvidenceCondition(sql`x.article_id`)}) AS members,
           ${rootFactOf(sql`f.story_id`)} AS root_fact_id
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN publications p ON p.article_id = fa.article_id
    JOIN articles a ON a.id = p.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE fa.fact_id = ANY(${ids}) AND fa.role IN ('primary', 'report') AND ${groupingEvidenceCondition(sql`fa.article_id`)}
    ORDER BY fa.fact_id, (fa.role = 'primary') DESC, p.timeline_at ASC`,
    sql<SelectedRow[]>`
      SELECT p.fact_id, p.article_id, p.title, p.summary, p.body_mode, p.score, p.timeline_at,
        s.name AS source, (s.tier = 'T1') AS first_party, p.published_at AS at, a.publication_time AS "publicationTime",
        ${REPRESENTATIVE_COLUMNS}
      FROM publications p JOIN articles a ON a.id = p.article_id JOIN sources s ON s.id = p.source_id JOIN facts f ON f.id = p.fact_id
      WHERE p.fact_id = ANY(${ids}) AND ${selectedCondition(new Date())} AND ${ownFactEvidenceCondition()}`,
  ]);
  const byFact = new Map(rows.map((r) => [Number(r.fact_id), r]));
  return recalled.flatMap((r) => {
    const row = byFact.get(r.factId);
    if (!row) return [];
    // Identity uses the eligible reports above. For reading value show exactly the representative
    // already visible in 精选; a merely scored or still-pending report is not prior reader coverage.
    const selectedMembers = selectedRows.filter((p) => Number(p.fact_id) === r.factId);
    const selected = selectedMembers.length ? pickRepresentative(selectedMembers) : null;
    return [{
      factId: r.factId,
      storyId: Number(row.story_id),
      factTitle: row.fact_title,
      members: Number(row.members),
      storyRoot: Number(row.root_fact_id) === r.factId,
      score: r.score,
      selected: selected !== null,
      selectedReport: selected ? { title: selected.title, summary: selected.summary, source: selected.source, firstParty: selected.first_party, at: selected.at, publicationTime: selected.publicationTime } : null,
      report: {
        title: row.title, source: row.source, firstParty: row.first_party, at: row.at, publicationTime: row.publicationTime, summary: row.summary,
        frame: { subject: row.subject, action: row.action, object: row.object, occurredAt: row.occurred_at ? beijingDate(row.occurred_at) : null },
      },
    }];
  });
}

/** The live fact another report of the same page, or the X post this one replies to or quotes, belongs to. */
export async function relatedPosts(a: { id: string; url: string; x_post: { replyTo?: string | null; quoted?: { url?: string } | null } | null }): Promise<{ sameUrl: PoolRow | null; referenced: PoolRow[] }> {
  const [sameUrl] = await sql<PoolRow[]>`
    SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title
    FROM articles b JOIN fact_articles fa ON fa.article_id = b.id AND fa.role IN ('primary', 'report')
    JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    WHERE b.url = ${a.url} AND b.id <> ${a.id} AND ${groupingEvidenceCondition(sql`fa.article_id`)} ORDER BY fa.created_at LIMIT 1`;
  const ids = [a.x_post?.replyTo ?? null, a.x_post?.quoted?.url ? (/\/status\/(\d+)/.exec(a.x_post.quoted.url)?.[1] ?? null) : null].filter((x): x is string => !!x);
  const referenced = ids.length
    ? await sql<PoolRow[]>`
        SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title
        FROM articles b JOIN fact_articles fa ON fa.article_id = b.id AND fa.role IN ('primary', 'report')
        JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
        WHERE b.identity_key = ANY(${ids.map((id) => `x:${id}`)}) AND b.id <> ${a.id} AND ${groupingEvidenceCondition(sql`fa.article_id`)}`
    : [];
  return { sameUrl: sameUrl ?? null, referenced };
}
