// Event grouping. A report attaches to a fact, the same real-world occurrence, and
// facts hang on a story, an occurrence with its direct developments. Recall: the same title-and-
// summary embedding on both sides over the reports of the last 14 days, plus the same URL and the X
// post a post replies to or quotes. Identity: one three-way relation judgement over the candidate
// facts with their representative reports fully described (relate.ts); a merge that is not obvious
// from similarity is confirmed by a second vendor before it is written; a development attaches only
// to the fact that started its story, so stories do not grow by chaining. Manual corrections are
// never overwritten; a revision keeps its membership unless an editor asks for a regroup. When a
// report is firmly tied to two stories, their roots are compared directly and the stories merge
// when both models see one story (consolidate); stories that stay apart though reports keep tying
// them list each other as related (linkRelatedStories). A story a regrouped report leaves without
// reports merges into where it went, so its address keeps working. A report waiting for a regroup
// (regroup_pending) is not evidence for others until it is decided again, so a regroup in discovery
// order sees what live grouping would have seen. Discussion posts that found no story get another
// look when a report founds a fact close to them (rematchSignals); history (isHistorical) founds no
// event. Runs serially (queue concurrency 1).
import { modelFor } from "../editorial/models.ts";
import { sql, type Db } from "../db.ts";
import { newShortId, newUuid, sha256 } from "../lib/ids.ts";
import { chatJson } from "../providers/llm.ts";
import { BudgetExceededError, ReceiptBusyError, completeReceipt } from "../providers/receipts.ts";
import { EMBEDDING_MODEL, compatibleEmbedding, cosine, embeddingsAvailable, ensureEmbeddings } from "../providers/embeddings.ts";
import { isHistorical, STALE_ON_DISCOVERY_MS } from "../content/materials.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { publishArticle } from "../publication/publish.ts";
import { mergeStoryInto } from "./merge.ts";
import {
  BATCH_SYSTEM, BatchSchema, PAIR_SYSTEM, PairSchema, RELATE_PROMPT_VERSION, SIGNAL_SYSTEM, STORY_REVIEW_MIN_CONFIDENCE, SignalSchema, TIE_MIN_CONFIDENCE,
  batchUser, firmlyTied, lexicalSimilarity, looksLikeRoundup, pairUser, reportText, sameOccurrence, signalTarget, storyForDevelopment, verdictsByFact,
  type CandidateView, type Relation, type ReportView, type Verdict,
} from "./relate.ts";

export const GROUP_PROMPT_VERSION = RELATE_PROMPT_VERSION;
/** Reports discovered this recently are candidates (keyed on discovery, so an old page found today still meets its peers). */
const RECALL_DAYS = 14;
const RECALL_MIN_COSINE = 0.6;
const RECALL_TOP_FACTS = 10;
/** A merge with a candidate less similar than this is confirmed by the review model before it is written. */
const CONFIRM_BELOW_COSINE = 0.85;
/** Discussion posts are judged only against clear candidates, and attach without a call when nearly identical. */
const SIGNAL_MIN_COSINE = 0.72;
const SIGNAL_AUTO_COSINE = 0.92;
const SIGNAL_TOP_FACTS = 4;

interface ArticleRow {
  id: string;
  title: string;
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  grouped_at: Date | null;
  body_text: string | null;
  x_post: { tweetId?: string; replyTo?: string | null; quoted?: { url?: string } | null } | null;
  source_id: string;
  source_name: string;
  signal_group_id: string | null;
  first_party: boolean;
  participation_mode: string;
  regroup_pending: boolean;
  backfill: boolean;
}

interface PoolRow {
  article_id: string;
  fact_id: number;
  story_id: number;
  fact_title: string;
}

interface Recalled {
  factId: number;
  storyId: number;
  factTitle: string;
  score: number;
}

export function participantKey(source: { id: string; signal_group_id: string | null }): string {
  return source.signal_group_id ? `group:${source.signal_group_id}` : `source:${source.id}`;
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/** A membership is evidence unless its report waits for a regroup; a manual one always is. */
const trusted = (alias: string) =>
  sql`(${sql(alias)}.manual OR NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = ${sql(alias)}.article_id))`;

/**
 * The fact that started a story: the one whose earliest trusted report came first. Fact ids do not
 * follow time once stories merge or come from an import, and an emptied fact starts nothing.
 */
const rootFactOf = (story: ReturnType<typeof sql> | number) => sql`(
  SELECT y.id FROM facts y
  JOIN fact_articles z ON z.fact_id = y.id AND z.role IN ('primary', 'report') AND ${trusted("z")}
  JOIN publications q ON q.article_id = z.article_id
  WHERE y.story_id = ${story}
  ORDER BY coalesce(q.published_at, q.discovered_at), y.id
  LIMIT 1)`;

/** Reports of the recall window that belong to a live fact; those waiting for a regroup only when asked for (the warm-up). */
async function recallPool(withWaiting = false): Promise<PoolRow[]> {
  return sql<PoolRow[]>`
    SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title
    FROM fact_articles fa
    JOIN facts f ON f.id = fa.fact_id
    JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    JOIN articles a ON a.id = fa.article_id
    WHERE fa.role IN ('primary', 'report') AND ${withWaiting ? sql`true` : trusted("fa")} AND a.discovered_at > now() - make_interval(days => ${RECALL_DAYS})`;
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

// Vectors of the recall window stay in the worker process; only new or changed texts are embedded
// (and stored) again. Grouping is serial, so one process holds the whole window.
const vectorCache = new Map<string, { hash: string; vector: Float32Array }>();

async function vectorsFor(items: Array<{ id: string; text: string }>): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: Array<{ id: string; text: string; hash: string }> = [];
  for (const it of items) {
    const hash = sha256(it.text);
    const cached = vectorCache.get(it.id);
    if (cached && cached.hash === hash) out.set(it.id, cached.vector);
    else missing.push({ ...it, hash });
  }
  if (missing.length) {
    const got = await ensureEmbeddings("article", missing.map((m) => ({ id: m.id, text: m.text })));
    for (const m of missing) {
      const v = got.get(m.id);
      if (!v) continue;
      const vector = Float32Array.from(v);
      vectorCache.set(m.id, { hash: m.hash, vector });
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
  const stored = new Set((await sql<{ ref_id: string; text_hash: string; vector: number[] }[]>`
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
async function recallFacts(queryId: string, queryText: string, minScore: number, top: number, boost: PoolRow[] = []): Promise<Recalled[]> {
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
      // Window members already in the cache keep their vector (a later revision of their text is
      // picked up when the cache turns over); only new members and the query are embedded now.
      const ids = [...new Set(pool.map((r) => r.article_id))];
      const uncached = ids.filter((id) => !vectorCache.has(id));
      const texts = await reportTexts(uncached);
      const fresh = await vectorsFor([{ id: queryId, text: queryText }, ...uncached.map((id) => ({ id, text: texts.get(id) ?? "" })).filter((x) => x.text)]);
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
async function candidateViews(recalled: Recalled[]): Promise<CandidateView[]> {
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
    WHERE fa.fact_id = ANY(${recalled.map((r) => r.factId)}) AND fa.role IN ('primary', 'report') AND ${trusted("fa")}
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
        frame: { subject: row.subject, action: row.action, object: row.object, occurredAt: row.occurred_at ? row.occurred_at.toISOString().slice(0, 10) : null },
      },
    }];
  });
}

// ---------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------

async function judgeBatch(articleId: string, query: ReportView, cands: CandidateView[]): Promise<{ verdicts: Map<number, Verdict>; receiptId: number }> {
  const res = await chatJson({
    model: await modelFor("group"), purpose: "group_article", subject: `article:${articleId}`, promptVersion: RELATE_PROMPT_VERSION,
    system: BATCH_SYSTEM, user: batchUser(query, cands), schema: BatchSchema, temperature: 0, maxTokens: 200 + 90 * cands.length,
  });
  return { verdicts: verdictsByFact(res.data.decisions, cands), receiptId: res.receiptId };
}

/** The review model reads both reports on their own; a merge stands only when it agrees. */
async function confirmMerge(articleId: string, query: ReportView, cand: CandidateView): Promise<{ relation: Relation; receiptId: number }> {
  const res = await chatJson({
    model: await modelFor("groupReview"), purpose: "group_review", subject: `article:${articleId}:fact:${cand.factId}`, promptVersion: RELATE_PROMPT_VERSION,
    system: PAIR_SYSTEM, user: pairUser(query, cand.report), schema: PairSchema, temperature: 0, maxTokens: 400,
  });
  return { relation: res.data.relation, receiptId: res.receiptId };
}

async function judgeSignal(articleId: string, query: ReportView, cands: CandidateView[]): Promise<{ verdicts: Map<number, Verdict>; receiptId: number }> {
  const res = await chatJson({
    model: await modelFor("group"), purpose: "group_signal", subject: `article:${articleId}`, promptVersion: RELATE_PROMPT_VERSION,
    system: SIGNAL_SYSTEM, user: batchUser(query, cands, "帖子"), schema: SignalSchema, temperature: 0, maxTokens: 150 + 60 * cands.length,
  });
  return { verdicts: verdictsByFact(res.data.decisions, cands), receiptId: res.receiptId };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function createStory(db: Db, title: string, at: Date): Promise<number> {
  const [row] = await db<{ id: number }[]>`
    INSERT INTO stories (public_id, title, status, first_report_at, latest_at, origin)
    VALUES (${newUuid()}, ${title}, 'active', ${at}, ${at}, 'model') RETURNING id`;
  return row!.id;
}

async function createFact(db: Db, storyId: number, title: string, frame: Record<string, any> | null, at: Date): Promise<number> {
  const occurred = typeof frame?.occurredAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(frame.occurredAt) ? new Date(`${frame.occurredAt}T00:00:00+08:00`) : null;
  const [row] = await db<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title, subject, action, object, occurred_at, created_at)
    VALUES (${`f${newShortId(8)}`}, ${storyId}, ${title}, ${frame?.subject ?? null}, ${frame?.action ?? null}, ${frame?.object ?? null}, ${occurred}, ${at})
    RETURNING id`;
  return row!.id;
}

async function recordSignal(db: Db, storyId: number, articleId: string, source: { id: string; signal_group_id: string | null }, kind: "editorial" | "signal", observedAt: Date) {
  await db`
    INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${storyId}, ${articleId}, ${participantKey(source)}, ${source.id}, ${kind}, ${observedAt})
    ON CONFLICT (story_id, article_id) DO NOTHING`;
  await db`UPDATE stories SET latest_at = GREATEST(coalesce(latest_at, ${observedAt}), ${observedAt}),
              first_report_at = LEAST(coalesce(first_report_at, ${observedAt}), ${observedAt}), updated_at = now()
            WHERE id = ${storyId}`;
}

type DecisionCandidate = { id: number; score: number; relation?: Relation; confidence?: number };

async function recordDecision(db: Db, articleId: string, factId: number | null, storyId: number | null, verdict: string, candidates: DecisionCandidate[], receiptId: number | null) {
  await db`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict, candidates, receipt_id)
           VALUES (${articleId}, ${factId}, ${storyId}, ${verdict}, ${db.json(candidates as never)}, ${receiptId})`;
}

/** A manual membership, or "keep standalone": either wins over any model decision. */
async function manualDecision(db: Db, articleId: string): Promise<{ factId: number | undefined } | null> {
  const [manual] = await db<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${articleId} AND manual LIMIT 1`;
  if (manual) return { factId: manual.fact_id };
  const [standalone] = await db`SELECT 1 FROM grouping_overrides WHERE article_id = ${articleId}`;
  return standalone ? { factId: undefined } : null;
}

/** The automatic membership a report already has (a revision keeps it). */
async function currentMembership(articleId: string): Promise<{ factId: number; storyId: number } | null> {
  const [row] = await sql<{ fact_id: number; story_id: number }[]>`
    SELECT fa.fact_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${articleId} AND fa.role IN ('primary', 'report') AND st.merged_into IS NULL
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  return row ? { factId: Number(row.fact_id), storyId: Number(row.story_id) } : null;
}

/**
 * An explicit regroup starts from a clean slate: automatic memberships and heat evidence go, manual
 * ones stay. Returns the stories the report was a report of.
 */
async function resetAutomatic(articleId: string): Promise<number[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT 1 FROM articles WHERE id = ${articleId} FOR UPDATE`;
    const left = await tx<{ story_id: number }[]>`
      SELECT DISTINCT f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
      WHERE fa.article_id = ${articleId} AND NOT fa.manual AND fa.role IN ('primary', 'report') AND f.story_id IS NOT NULL`;
    await tx`DELETE FROM fact_articles WHERE article_id = ${articleId} AND NOT manual`;
    await tx`DELETE FROM story_signals WHERE article_id = ${articleId}`;
    return left.map((r) => Number(r.story_id));
  });
}

/**
 * Stories the report sat in before (its reset, or an earlier decision) that hold no report now keep
 * their address: each merges into the report's story, so its public id redirects there.
 */
async function redirectEmptiedStories(articleId: string, left: number[], storyId: number): Promise<number[]> {
  const emptied = await sql<{ id: number }[]>`
    SELECT st.id FROM stories st
    WHERE (st.id = ANY(${left}::bigint[]) OR st.id IN (SELECT d.story_id FROM grouping_decisions d WHERE d.article_id = ${articleId}))
      AND st.id <> ${storyId} AND st.merged_into IS NULL
      AND NOT EXISTS (SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id WHERE f.story_id = st.id AND fa.role IN ('primary', 'report'))`;
  const redirected: number[] = [];
  for (const { id } of emptied) {
    if (await mergeStoryInto(Number(id), storyId, `报道已全部移走，旧地址跳到报道所在事件（最后一篇 ${articleId}）`, "grouping")) redirected.push(Number(id));
  }
  return redirected;
}

async function markGrouped(articleId: string) {
  await sql`UPDATE articles SET grouped_at = coalesce(grouped_at, now()) WHERE id = ${articleId}`;
}

/** The live fact another report of the same page, or the X post this one replies to or quotes, belongs to. */
async function relatedPosts(a: ArticleRow): Promise<{ sameUrl: PoolRow | null; referenced: PoolRow[] }> {
  const [sameUrl] = await sql<PoolRow[]>`
    SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title
    FROM articles b JOIN fact_articles fa ON fa.article_id = b.id AND fa.role IN ('primary', 'report')
    JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    WHERE b.url = ${a.url} AND b.id <> ${a.id} AND ${trusted("fa")} ORDER BY fa.created_at LIMIT 1`;
  const ids = [a.x_post?.replyTo ?? null, a.x_post?.quoted?.url ? (/\/status\/(\d+)/.exec(a.x_post.quoted.url)?.[1] ?? null) : null].filter((x): x is string => !!x);
  const referenced = ids.length
    ? await sql<PoolRow[]>`
        SELECT fa.article_id, fa.fact_id, f.story_id, f.title AS fact_title
        FROM articles b JOIN fact_articles fa ON fa.article_id = b.id AND fa.role IN ('primary', 'report')
        JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
        WHERE b.identity_key = ANY(${ids.map((id) => `x:${id}`)}) AND b.id <> ${a.id} AND ${trusted("fa")}`
    : [];
  return { sameUrl: sameUrl ?? null, referenced };
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

interface StoryRoot {
  storyId: number;
  at: Date;
  /** The story started as a multi-topic digest: never merged. */
  roundup: boolean;
  report: ReportView;
}

/** A story's root (rootFactOf), when it started, and the report that stands for it. */
async function storyRoot(storyId: number): Promise<StoryRoot | null> {
  const [row] = await sql<{
    subject: string | null; action: string | null; object: string | null; occurred_at: Date | null;
    title: string; summary: string | null; source: string; first_party: boolean; at: Date; started_at: Date; roundup: boolean;
  }[]>`
    SELECT f.subject, f.action, f.object, f.occurred_at, p.title, p.summary, s.name AS source, p.first_party,
           coalesce(p.published_at, p.discovered_at) AS at,
           (SELECT min(coalesce(q.published_at, q.discovered_at)) FROM fact_articles z JOIN publications q ON q.article_id = z.article_id
            WHERE z.fact_id = f.id AND z.role IN ('primary', 'report') AND ${trusted("z")}) AS started_at,
           EXISTS (SELECT 1 FROM grouping_decisions d WHERE d.article_id = fa.article_id AND d.verdict = 'roundup') AS roundup
    FROM facts f
    JOIN fact_articles fa ON fa.fact_id = f.id AND fa.role IN ('primary', 'report') AND ${trusted("fa")}
    JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.id = ${rootFactOf(storyId)}
    ORDER BY (fa.role = 'primary') DESC, p.timeline_at ASC
    LIMIT 1`;
  if (!row) return null;
  return {
    storyId, at: row.started_at, roundup: row.roundup,
    report: {
      title: row.title, source: row.source, firstParty: row.first_party, at: row.at, summary: row.summary,
      frame: { subject: row.subject, action: row.action, object: row.object, occurredAt: row.occurred_at ? row.occurred_at.toISOString().slice(0, 10) : null },
    },
  };
}

async function judgeStories(capability: "group" | "groupReview", a: StoryRoot, b: StoryRoot): Promise<{ relation: Relation; confidence: number; difference: string; receiptId: number }> {
  const res = await chatJson({
    model: await modelFor(capability), purpose: capability === "group" ? "group_story" : "group_story_review", subject: `story:${a.storyId}:${b.storyId}`,
    promptVersion: RELATE_PROMPT_VERSION, system: PAIR_SYSTEM, user: pairUser(a.report, b.report), schema: PairSchema, temperature: 0, maxTokens: 400,
  });
  return { relation: res.data.relation, confidence: res.data.confidence, difference: res.data.difference, receiptId: res.receiptId };
}

async function liveStory(id: number): Promise<number | null> {
  let current = id;
  for (let hops = 0; hops < 20; hops++) {
    const [st] = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id = ${current}`;
    if (!st) return null;
    if (st.merged_into === null) return current;
    current = Number(st.merged_into);
  }
  return null;
}

export interface Consolidation {
  from: number;
  into: number;
  /** Both models see one story (in a dry run: would merge). */
  merge: boolean;
  first: Relation;
  second: Relation | null;
  fromTitle: string;
  intoTitle: string;
  difference: string;
}

/**
 * Stories a report is firmly tied to may be one story that grew two roots. Their roots are compared
 * directly, the earliest against each of the others, and a story merges into the earliest only when
 * the judge and then the review model both see one occurrence or a direct development: a report tied
 * to two different events (a comparison, a roundup) cannot fuse them on its own.
 */
export async function consolidate(storyIds: number[], opts: { dryRun?: boolean } = {}): Promise<Consolidation[]> {
  const live = new Set<number>();
  for (const id of storyIds) {
    const s = await liveStory(id);
    if (s !== null) live.add(s);
  }
  if (live.size < 2) return [];
  const roots = (await Promise.all([...live].map(storyRoot))).filter((r): r is StoryRoot => !!r && !r.roundup);
  if (roots.length < 2) return [];
  roots.sort((x, y) => x.at.getTime() - y.at.getTime() || x.storyId - y.storyId);
  const [anchor, ...others] = roots as [StoryRoot, ...StoryRoot[]];
  const out: Consolidation[] = [];
  for (const other of others) {
    const base = { from: other.storyId, into: anchor.storyId, fromTitle: other.report.title, intoTitle: anchor.report.title };
    const first = await judgeStories("group", anchor, other);
    await completeReceipt(sql, first.receiptId);
    if (!firmlyTied(first.relation, first.confidence)) {
      out.push({ ...base, merge: false, first: first.relation, second: null, difference: first.difference });
      continue;
    }
    // The review model reads the pair the other way round.
    const second = await judgeStories("groupReview", other, anchor);
    await completeReceipt(sql, second.receiptId);
    const merge = firmlyTied(second.relation, second.confidence, STORY_REVIEW_MIN_CONFIDENCE);
    if (merge && !opts.dryRun) {
      await mergeStoryInto(other.storyId, anchor.storyId, `同一事件（${first.relation}，复核 ${second.relation}）：${other.report.title}｜${anchor.report.title}`, "grouping");
    }
    out.push({ ...base, merge, first: first.relation, second: second.relation, difference: first.difference || second.difference });
  }
  return out;
}

/** Reports that must tie two stories that stay apart before each lists the other as a related event. */
const RELATED_MIN_REPORTS = 2;

/** The story began with a multi-topic digest: it is neither merged nor linked. */
const startedByRoundup = (story: ReturnType<typeof sql>) => sql`EXISTS (
  SELECT 1 FROM fact_articles r JOIN grouping_decisions d ON d.article_id = r.article_id AND d.verdict = 'roundup'
  WHERE r.fact_id = ${rootFactOf(story)})`;

/**
 * Stories that stay apart although reports tie them (a reaction, a development of a later fact, a
 * comparison) list each other as related events: at least two reports decided in the recall window,
 * each firmly tied to a fact of the other story, none of them a roundup, neither story started by
 * one. A single tie is too often a stray answer about one candidate among many. Links are only
 * added; a merged story drops out where links are read.
 */
export async function linkRelatedStories(): Promise<{ added: number }> {
  const [row] = await sql<{ added: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (article_id) article_id, verdict, candidates FROM grouping_decisions
      WHERE created_at > now() - make_interval(days => ${RECALL_DAYS}) ORDER BY article_id, id DESC),
    ties AS (
      SELECT DISTINCT l.article_id, own.story_id AS a, other.story_id AS b
      FROM latest l
      JOIN fact_articles fa ON fa.article_id = l.article_id AND fa.role IN ('primary', 'report')
      JOIN facts own ON own.id = fa.fact_id
      CROSS JOIN LATERAL jsonb_array_elements(l.candidates) c
      JOIN facts other ON other.id = (c->>'id')::bigint
      WHERE l.verdict IN ('same-fact', 'same-url', 'new-fact-in-story', 'new-story')
        AND c->>'relation' IN ('SAME_OCCURRENCE', 'SAME_STORY') AND (c->>'confidence')::numeric >= ${TIE_MIN_CONFIDENCE}
        AND other.story_id <> own.story_id),
    pairs AS (
      SELECT least(a, b) AS x, greatest(a, b) AS y FROM ties GROUP BY 1, 2 HAVING count(DISTINCT article_id) >= ${RELATED_MIN_REPORTS}),
    linked AS (
      SELECT p.x, p.y FROM pairs p
      JOIN stories sx ON sx.id = p.x AND sx.merged_into IS NULL
      JOIN stories sy ON sy.id = p.y AND sy.merged_into IS NULL
      WHERE NOT ${startedByRoundup(sql`p.x`)} AND NOT ${startedByRoundup(sql`p.y`)}),
    added AS (
      INSERT INTO story_links (story_id, other_id, relation)
      SELECT x, y, 'related' FROM linked UNION ALL SELECT y, x, 'related' FROM linked
      ON CONFLICT (story_id, other_id) DO NOTHING RETURNING 1)
    SELECT count(*)::int AS added FROM added`;
  return { added: row?.added ?? 0 };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface GroupResult {
  verdict:
    | "same-fact" | "same-url" | "new-fact-in-story" | "new-story" | "roundup" | "kept" | "standalone" | "manual" | "skipped"
    | "signal" | "signal-native" | "signal-unmatched" | "historical";
  factId?: number;
  storyId?: number;
  /** Stories compared because this report tied them together (see consolidate). */
  consolidated?: Consolidation[];
  consolidationError?: string;
  /** Stories left without reports when this report moved: merged into its story, their public ids redirect. */
  redirected?: number[];
  /** Earlier discussion posts close to the fact this report founded, grouped again (rematchSignals). */
  rematched?: number;
  /** Earlier discussion posts replying to or quoting this post, grouped again (reclaimWaiting). */
  reclaimed?: number;
  reclaimError?: string;
  rematchError?: string;
}

export interface GroupOptions {
  /** Discussion evidence only (hot_signal sources): attach to a story, never create one. */
  signalOnly?: boolean;
  /** An explicit regroup: drop the automatic membership and decide again (manual decisions still win). A report waiting in regroup_pending is regrouped the same way. */
  force?: boolean;
}

export async function groupArticle(articleId: string, opts: GroupOptions = {}): Promise<GroupResult> {
  const result = await decide(articleId, opts);
  // Decided under the current rules: the report is evidence for others again. A failed decision
  // throws before this, so the report keeps waiting and the retry decides it again.
  await sql`DELETE FROM regroup_pending WHERE article_id = ${articleId}`;
  return result;
}

async function decide(articleId: string, opts: GroupOptions): Promise<GroupResult> {
  const [a] = await sql<ArticleRow[]>`
    SELECT a.id, a.title, a.url, a.published_at, a.discovered_at, a.grouped_at, a.body_text, a.x_post, a.backfill,
           s.id AS source_id, s.name AS source_name, s.signal_group_id, s.first_party, s.participation_mode,
           EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = a.id) AS regroup_pending
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a) return { verdict: "skipped" };
  const observedAt = a.published_at ?? a.discovered_at;
  const source = { id: a.source_id, signal_group_id: a.signal_group_id };

  // Manual decisions win over any model decision: a manual membership, or "keep standalone".
  const manual = await manualDecision(sql, articleId);
  if (manual) {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "manual", factId: manual.factId };
  }
  const left = opts.force || a.regroup_pending ? await resetAutomatic(articleId) : [];

  // History founds no event and adds no heat (isHistorical); a regroup takes it out of any it joined.
  if (isHistorical(a)) {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "historical" };
  }

  if (opts.signalOnly || a.participation_mode !== "editorial") return groupSignal(a, source, observedAt);

  const kept = await currentMembership(articleId);
  if (kept) {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "kept", factId: kept.factId, storyId: kept.storyId };
  }

  const [an] = await sql<{ relevance: string | null; title_zh: string | null; summary_zh: string | null; output: Record<string, any> | null }[]>`
    SELECT relevance, title_zh, summary_zh, output FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  const frame = (an?.output?.fact ?? null) as Record<string, any> | null;
  if (!an || an.relevance !== "pass") {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "standalone" };
  }
  const title = an.title_zh || a.title;
  const query: ReportView = {
    title, source: a.source_name, firstParty: a.first_party, at: observedAt, summary: an.summary_zh,
    frame: frame ? { subject: frame.subject, action: frame.action, object: frame.object, occurredAt: frame.occurredAt } : null,
  };
  const newTitle = String(frame?.title || title).slice(0, 60);

  const { sameUrl, referenced } = await relatedPosts(a);
  let verdict: GroupResult["verdict"] = "new-story";
  let factId: number | null = null;
  let storyId: number | null = null;
  let cands: CandidateView[] = [];
  let verdicts = new Map<number, Verdict>();
  const receipts: number[] = [];

  if (sameUrl) {
    verdict = "same-url";
    factId = sameUrl.fact_id;
    storyId = sameUrl.story_id;
  } else {
    try {
      cands = await candidateViews(await recallFacts(articleId, reportText(title, an.summary_zh), RECALL_MIN_COSINE, RECALL_TOP_FACTS, referenced));
      if (cands.length) {
        const judged = await judgeBatch(articleId, query, cands);
        verdicts = judged.verdicts;
        receipts.push(judged.receiptId);
        for (const pick of sameOccurrence(cands, verdicts)) {
          if (pick.score >= CONFIRM_BELOW_COSINE) {
            factId = pick.factId;
            break;
          }
          const review = await confirmMerge(articleId, query, pick);
          receipts.push(review.receiptId);
          if (review.relation === "SAME_OCCURRENCE") {
            factId = pick.factId;
            break;
          }
          if (review.relation === "SAME_STORY" && pick.storyRoot) {
            storyId = pick.storyId;
            break;
          }
        }
        if (factId) {
          verdict = "same-fact";
          storyId = cands.find((c) => c.factId === factId)!.storyId;
        } else if (storyId) {
          verdict = "new-fact-in-story";
        } else {
          const dev = storyForDevelopment(cands, verdicts);
          if (dev) {
            verdict = "new-fact-in-story";
            storyId = dev.storyId;
          } else if (looksLikeRoundup(cands, verdicts)) verdict = "roundup";
        }
      }
    } catch (error) {
      // A failed identity call must not block publication: the report stays standalone for now.
      await markGrouped(articleId);
      await publishArticle(articleId);
      throw error;
    }
  }

  const decisionCandidates: DecisionCandidate[] = cands.map((c) => ({
    id: c.factId, score: Math.round(c.score * 1000) / 1000, relation: verdicts.get(c.factId)?.relation, confidence: verdicts.get(c.factId)?.confidence,
  }));
  if (sameUrl) decisionCandidates.push({ id: sameUrl.fact_id, score: 1, relation: "SAME_OCCURRENCE", confidence: 1 });

  // Written under the article's row lock after reading the manual state again: a detach or other
  // manual decision made while the model was answering wins (detachFromFact takes the same lock).
  const written = await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM articles WHERE id = ${articleId} FOR UPDATE`;
    const late = await manualDecision(tx, articleId);
    if (late) {
      await tx`UPDATE articles SET grouped_at = coalesce(grouped_at, now()) WHERE id = ${articleId}`;
      return { manual: late, factId: null, storyId: null };
    }
    const story = storyId ?? (await createStory(tx, newTitle, observedAt));
    const fact = factId ?? (await createFact(tx, story, newTitle, frame, observedAt));
    const [hasPrimary] = await tx<{ n: number }[]>`SELECT count(*) AS n FROM fact_articles WHERE fact_id = ${fact} AND role = 'primary'`;
    const role = a.first_party && Number(hasPrimary?.n ?? 0) === 0 ? "primary" : "report";
    await tx`INSERT INTO fact_articles (fact_id, article_id, role, created_at) VALUES (${fact}, ${articleId}, ${role}, ${observedAt}) ON CONFLICT (fact_id, article_id) DO NOTHING`;
    await recordSignal(tx, story, articleId, source, "editorial", observedAt);
    await recordDecision(tx, articleId, fact, story, verdict, decisionCandidates, receipts[0] ?? null);
    await tx`UPDATE articles SET grouped_at = coalesce(grouped_at, now()) WHERE id = ${articleId}`;
    return { manual: null, factId: fact, storyId: story };
  });
  for (const id of receipts) await completeReceipt(sql, id);
  await publishArticle(articleId);
  if (written.manual) return { verdict: "manual", factId: written.manual.factId };
  const result: GroupResult = { verdict, factId: written.factId!, storyId: written.storyId! };

  // Other stories this report is firmly tied to: one story may have grown two roots. Best effort:
  // the report's own decision is written; a failed comparison is reported in the job's result.
  const tied = new Set<number>([written.storyId!]);
  for (const c of cands) if (firmlyTied(verdicts.get(c.factId)?.relation, verdicts.get(c.factId)?.confidence)) tied.add(c.storyId);
  if (tied.size > 1) {
    try {
      result.consolidated = await consolidate([...tied]);
      result.storyId = (await liveStory(written.storyId!)) ?? written.storyId!;
    } catch (error) {
      result.consolidationError = String(error).slice(0, 300);
    }
  }
  const redirected = await redirectEmptiedStories(articleId, left, result.storyId!);
  if (redirected.length) result.redirected = redirected;
  // Discussion posts that reply to or quote this post and came first now have its story, whichever
  // fact it joined (the posts waiting on an original wake when the original arrives).
  if (a.x_post?.tweetId) {
    try {
      result.reclaimed = await reclaimWaiting(a.x_post.tweetId);
    } catch (error) {
      result.reclaimError = String(error).slice(0, 300);
    }
  }
  // A new fact may be what discussion posts of the last hours were about before any report came.
  if (verdict === "new-story" || verdict === "new-fact-in-story") {
    try {
      result.rematched = await rematchSignals(articleId, reportText(title, an.summary_zh));
    } catch (error) {
      result.rematchError = String(error).slice(0, 300);
    }
  }
  return result;
}

/** How far back discussion posts that found no story get another look when a new fact appears. */
const REMATCH_HOURS = 6;
/** How long a discussion post waits for the post it replies to or quotes (48 hours). */
const WAIT_HOURS = 48;

/** Discussion posts not yet attached to any story (a post a person placed or detached is left alone). */
const unattachedSignal = sql`
  s.participation_mode = 'hot_signal' AND a.processing_state = 'skipped'
  AND (NOT a.backfill OR a.discovered_at - a.published_at <= make_interval(secs => ${STALE_ON_DISCOVERY_MS / 1000}))
  AND NOT EXISTS (SELECT 1 FROM story_signals ss WHERE ss.article_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM grouping_decisions d WHERE d.article_id = a.id AND d.verdict <> 'signal-unmatched')
  AND NOT EXISTS (SELECT 1 FROM grouping_overrides o WHERE o.article_id = a.id)`;

/**
 * A reaction often comes before the post it quotes is collected (Dan Shipper's "SONNET 5.5 IS OUT!"
 * a minute before Anthropic's post). When the original joins a fact, the recent unattached posts that
 * reply to or quote it are grouped again; groupSignal then attaches them through the reference.
 */
async function reclaimWaiting(tweetId: string): Promise<number> {
  const posts = await sql<{ id: string }[]>`
    SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.discovered_at > now() - make_interval(hours => ${WAIT_HOURS}) AND ${unattachedSignal}
      AND (a.x_post->>'replyTo' = ${tweetId} OR substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)') = ${tweetId})`;
  for (const p of posts) await enqueue(QUEUES.group, { articleId: p.id, signalOnly: true }, { singletonKey: p.id, priority: -1 });
  return posts.length;
}

/** The text a discussion post is recalled by: its title and the start of its body. */
const signalText = (a: { title: string; body_text: string | null }) => reportText(a.title, a.body_text?.slice(0, 300) ?? null);

/**
 * Discussion posts often come before the first report (Techmeme, reactions): they found no story
 * then and were left. When a report founds a fact, the recent unattached posts close to it are
 * grouped again; each is judged the usual way, against all candidates.
 */
async function rematchSignals(articleId: string, queryText: string): Promise<number> {
  if (!embeddingsAvailable()) return 0;
  const mine = (await vectorsFor([{ id: articleId, text: queryText }])).get(articleId);
  if (!mine) return 0;
  const posts = await sql<{ id: string; title: string; body_text: string | null }[]>`
    SELECT a.id, a.title, a.body_text FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.discovered_at > now() - make_interval(hours => ${REMATCH_HOURS}) AND ${unattachedSignal}`;
  const vectors = await vectorsFor(posts.map((p) => ({ id: p.id, text: signalText(p) })));
  let close = 0;
  for (const p of posts) {
    const v = vectors.get(p.id);
    if (!v || cosine(mine, v) < SIGNAL_MIN_COSINE) continue;
    // A post still waiting in the queue keeps that job (same key): it will meet the new fact anyway.
    await enqueue(QUEUES.group, { articleId: p.id, signalOnly: true }, { singletonKey: p.id, priority: -1 });
    close += 1;
  }
  return close;
}

/**
 * Discussion evidence (hot_signal sources): the post the item replies to or quotes decides first;
 * otherwise clear candidates are judged, and a nearly identical report attaches without a call.
 */
async function groupSignal(a: ArticleRow, source: { id: string; signal_group_id: string | null }, observedAt: Date): Promise<GroupResult> {
  const { referenced } = await relatedPosts(a);
  if (referenced.length) {
    const target = referenced[0]!;
    await recordSignal(sql, target.story_id, a.id, source, "signal", observedAt);
    await recordDecision(sql, a.id, target.fact_id, target.story_id, "signal-native", [{ id: target.fact_id, score: 1, relation: "SAME_STORY", confidence: 1 }], null);
    return { verdict: "signal-native", storyId: target.story_id };
  }
  if (!embeddingsAvailable()) return { verdict: "signal-unmatched" };
  const recalled = await recallFacts(a.id, signalText(a), SIGNAL_MIN_COSINE, SIGNAL_TOP_FACTS);
  if (recalled.length === 0) {
    // Recorded, so a post that found nothing is told apart from one never decided.
    await recordDecision(sql, a.id, null, null, "signal-unmatched", [], null);
    return { verdict: "signal-unmatched" };
  }
  const top = recalled[0]!;
  const asCandidates = (verdicts?: Map<number, Verdict>): DecisionCandidate[] =>
    recalled.map((r) => ({ id: r.factId, score: Math.round(r.score * 1000) / 1000, relation: verdicts?.get(r.factId)?.relation, confidence: verdicts?.get(r.factId)?.confidence }));
  if (top.score >= SIGNAL_AUTO_COSINE) {
    await recordSignal(sql, top.storyId, a.id, source, "signal", observedAt);
    await recordDecision(sql, a.id, top.factId, top.storyId, "signal", asCandidates(), null);
    return { verdict: "signal", storyId: top.storyId };
  }
  const cands = await candidateViews(recalled);
  if (cands.length === 0) return { verdict: "signal-unmatched" };
  const query: ReportView = { title: a.title, source: a.source_name, firstParty: false, at: observedAt, summary: a.body_text?.slice(0, 300) ?? null };
  const { verdicts, receiptId } = await judgeSignal(a.id, query, cands);
  const target = signalTarget(cands, verdicts);
  if (target) await recordSignal(sql, target.storyId, a.id, source, "signal", observedAt);
  await recordDecision(sql, a.id, target?.factId ?? null, target?.storyId ?? null, target ? "signal" : "signal-unmatched", asCandidates(verdicts), receiptId);
  await completeReceipt(sql, receiptId);
  return target ? { verdict: "signal", storyId: target.storyId } : { verdict: "signal-unmatched" };
}
