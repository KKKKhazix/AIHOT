// Candidate recall and embedding reuse for event grouping.
import { sql } from "../db.ts";
import { beijingDate } from "@aihot/contracts/time";
import { sha256 } from "../lib/ids.ts";
import { BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
import { embeddingsAvailable, ensureEmbeddings, compatibleEmbedding, EMBEDDING_MODEL, cosine } from "../providers/embeddings.ts";
import { lexicalSimilarity, reportText, type CandidateView } from "./relate.ts";
export const RECALL_DAYS = 14;
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

/** A membership is evidence unless its report waits for a regroup; a manual one always is. */
export const trusted = (alias: string) =>
  sql`(${sql(alias)}.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = ${sql(alias)}.article_id))`;

/**
 * The fact that started a story: the one whose earliest trusted report came first. Fact ids do not
 * follow time once stories merge or come from an import, and an emptied fact starts nothing.
 */
export const rootFactOf = (story: ReturnType<typeof sql> | number) => sql`(
  SELECT y.id FROM facts y
  JOIN fact_articles z ON z.fact_id = y.id AND z.role IN ('primary', 'report') AND ${trusted("z")}
  JOIN publications q ON q.article_id = z.article_id JOIN sources qs ON qs.id=q.source_id
  WHERE y.story_id = ${story} AND q.visibility='public' AND qs.participation_mode='editorial'
  ORDER BY coalesce(q.published_at, q.discovered_at), y.id
  LIMIT 1)`;

/** Reports of the recall window that belong to a live fact; those waiting for a regroup only when asked for (the warm-up). */
async function recallPool(withWaiting = false): Promise<PoolRow[]> {
  return sql<PoolRow[]>`
    SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title, p.revision
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    JOIN articles a ON a.id = fa.article_id
    JOIN publications p ON p.article_id=a.id JOIN sources s ON s.id=a.source_id
    WHERE p.visibility='public' AND s.participation_mode='editorial' AND fa.role IN ('primary', 'report') AND ${withWaiting ? sql`true` : trusted("fa")} AND a.discovered_at > now() - make_interval(days => ${RECALL_DAYS})`;
}

/** The public title and summary of reports (the analysis when a report has no publication yet). */
async function reportTexts(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; title: string; summary: string | null }[]>`
    SELECT a.id, coalesce(p.title, an.title_zh, a.title) AS title, coalesce(p.summary, an.summary_zh, '') AS summary
    FROM articles a JOIN sources s ON s.id=a.source_id
    LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN LATERAL (SELECT title_zh, summary_zh FROM analyses x WHERE x.article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
    WHERE a.id = ANY(${ids}) AND coalesce(p.visibility,'public')='public' AND s.participation_mode='editorial'`;
  return new Map(rows.map((r) => [r.id, reportText(r.title, r.summary)]));
}

// Vectors of the recall window stay in the worker process; only new or changed texts are embedded
// (and stored) again. Grouping is serial, so one process holds the whole window.
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
    const got = await ensureEmbeddings("article", missing.map((m) => ({ id: m.id, text: m.text })));
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

/**
 * Embeds every report of the recall window that has no stored vector yet, within the embedding
 * budget (waiting when it is exhausted). Run before a deploy that changes the embedded text or
 * before a regroup, so the first grouping job does not spend its retries on the backlog.
 */
export async function warmRecallWindow(onProgress?: (done: number, total: number) => void): Promise<{ total: number; embedded: number }> {
  if (!embeddingsAvailable()) return { total: 0, embedded: 0 };
  // Reports waiting for a regroup included: each counts again once its turn comes.
  const ids = [...new Set((await recallPool(true)).map((r) => r.article_id))];
  const texts = await reportTexts(ids);
  const items = ids.map((id) => ({ id, text: texts.get(id) ?? "" })).filter((x) => x.text);
  const stored = new Set((await sql<{ ref_id: string; text_hash: string; vector: unknown }[]>`
    SELECT ref_id, text_hash, vector FROM embeddings WHERE kind = 'article' AND model = ${EMBEDDING_MODEL} AND ref_id = ANY(${items.map((i) => i.id)})`)
    .filter((r) => compatibleEmbedding(r.vector)).map((r) => `${r.ref_id}:${r.text_hash}`));
  const missing = items.filter((i) => !stored.has(`${i.id}:${sha256(i.text)}`));
  let done = 0;
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    for (;;) {
      try {
        await ensureEmbeddings("article", batch);
        break;
      } catch (error) {
        // The worker may be embedding the same texts for a live grouping job: that batch is covered.
        if (error instanceof ReceiptBusyError) break;
        if (!(error instanceof BudgetExceededError)) throw error;
        await new Promise((r) => setTimeout(r, (error.retryAfterSeconds + 1) * 1000));
      }
    }
    done += batch.length;
    onProgress?.(done, missing.length);
  }
  return { total: items.length, embedded: missing.length };
}

/**
 * Facts whose reports are similar to the query text: the best report of each fact counts. Boosted
 * facts (a post the query replies to or quotes) are always included.
 */
export async function recallFacts(queryId: string, queryText: string, minScore: number, top: number, boost: PoolRow[] = []): Promise<Recalled[]> {
  const pool = (await recallPool()).filter((r) => r.article_id !== queryId);
  const best = new Map<number, Recalled>();
  const consider = (r: PoolRow, score: number) => {
    const prev = best.get(r.fact_id);
    if (!prev || score > prev.score) best.set(r.fact_id, { factId: r.fact_id, storyId: r.story_id, factTitle: r.fact_title, score });
  };
  if (pool.length) {
    if (!embeddingsAvailable()) {
      const texts = await reportTexts([...new Set(pool.map((r) => r.article_id))]);
      for (const r of pool) {
        const s = lexicalSimilarity(queryText, texts.get(r.article_id) ?? "");
        if (s >= 0.25) consider(r, s);
      }
    } else {
      // Publication revisions invalidate changed reports without fetching every cached text. The
      // text hash still avoids paying again when a revision changed only non-text public fields.
      const ids = [...new Set(pool.map((r) => r.article_id))];
      const revisions = new Map(pool.map((r) => [r.article_id, r.revision]));
      const uncached = ids.filter((id) => !vectorCache.has(id) || vectorCache.get(id)!.revision !== revisions.get(id));
      const texts = await reportTexts(uncached);
      const fresh = await vectorsFor([{ id: queryId, text: queryText }, ...uncached.map((id) => ({ id, text: texts.get(id) ?? "", revision: revisions.get(id) })).filter((x) => x.text)]);
      const mine = fresh.get(queryId);
      if (mine) {
        for (const r of pool) {
          const v = fresh.get(r.article_id) ?? vectorCache.get(r.article_id)?.vector;
          if (!v) continue;
          const s = cosine(mine, v);
          if (s >= minScore) consider(r, s);
        }
      }
    }
  }
  for (const r of boost) consider(r, 1);
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, top);
}

/**
 * What the judge sees of a candidate fact: its representative report (first-party first, else the
 * earliest), its size, and whether it started its story (rootFactOf).
 */
export async function candidateViews(recalled: Recalled[]): Promise<CandidateView[]> {
  if (recalled.length === 0) return [];
  const rows = await sql<{
    fact_id: number; story_id: number; fact_title: string; subject: string | null; action: string | null; object: string | null; occurred_at: Date | null;
    title: string; summary: string | null; source: string; first_party: boolean; at: Date; members: number; root_fact_id: number;
  }[]>`
    SELECT DISTINCT ON (fa.fact_id) fa.fact_id, f.story_id, f.title AS fact_title, f.subject, f.action, f.object, f.occurred_at,
           p.title, p.summary, s.name AS source, p.first_party, coalesce(p.published_at, p.discovered_at) AS at,
           (SELECT count(*) FROM fact_articles x WHERE x.fact_id = fa.fact_id AND x.role IN ('primary', 'report') AND ${trusted("x")}) AS members,
           ${rootFactOf(sql`f.story_id`)} AS root_fact_id
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE p.visibility='public' AND s.participation_mode='editorial'
      AND fa.fact_id = ANY(${recalled.map((r) => r.factId)}) AND fa.role IN ('primary', 'report') AND ${trusted("fa")}
    ORDER BY fa.fact_id, (fa.role = 'primary') DESC, p.timeline_at ASC`;
  const byFact = new Map(rows.map((r) => [Number(r.fact_id), r]));
  return recalled.flatMap((r) => {
    const row = byFact.get(r.factId);
    if (!row) return [];
    return [{
      factId: r.factId,
      storyId: Number(row.story_id),
      factTitle: row.fact_title,
      members: Number(row.members),
      storyRoot: Number(row.root_fact_id) === r.factId,
      score: r.score,
      report: {
        title: row.title, source: row.source, firstParty: row.first_party, at: row.at, summary: row.summary,
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
    JOIN publications p ON p.article_id=b.id JOIN sources s ON s.id=b.source_id
    WHERE p.visibility='public' AND s.participation_mode='editorial' AND b.url = ${a.url} AND b.id <> ${a.id} AND ${trusted("fa")} ORDER BY fa.created_at LIMIT 1`;
  const ids = [a.x_post?.replyTo ?? null, a.x_post?.quoted?.url ? (/\/status\/(\d+)/.exec(a.x_post.quoted.url)?.[1] ?? null) : null].filter((x): x is string => !!x);
  const referenced = ids.length
    ? await sql<PoolRow[]>`
        SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title
        FROM articles b JOIN fact_articles fa ON fa.article_id = b.id AND fa.role IN ('primary', 'report')
        JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
        JOIN publications p ON p.article_id=b.id JOIN sources s ON s.id=b.source_id
        WHERE p.visibility='public' AND s.participation_mode='editorial' AND b.identity_key = ANY(${ids.map((id) => `x:${id}`)}) AND b.id <> ${a.id} AND ${trusted("fa")}`
    : [];
  return { sameUrl: sameUrl ?? null, referenced };
}
