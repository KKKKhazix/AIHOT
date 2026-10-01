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
import { beijingDate } from "@aihot/contracts/time";
import { candidateViews, recallFacts, relatedPosts, vectorsFor } from "./recall.ts";
import { consolidate, liveStory, type Consolidation } from "./consolidate.ts";
import { modelFor } from "../editorial/models.ts";
import { sql, type Db, type Tx } from "../db.ts";
import { newShortId, newUuid } from "../lib/ids.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { embeddingsAvailable, cosine } from "../providers/embeddings.ts";
import { isHistorical, STALE_ON_DISCOVERY_MS } from "../content/materials.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { invalidateStoryInputs, lockStoryMembership } from "./derived-content.ts";
import { publishArticle } from "../publication/publish.ts";
import { mergeStoryInto } from "./merge.ts";
import {
  BATCH_SYSTEM, BatchSchema, PAIR_SYSTEM, PairSchema, RELATE_PROMPT_VERSION, SIGNAL_SYSTEM, STORY_REVIEW_MIN_CONFIDENCE, SignalSchema, TIE_MIN_CONFIDENCE,
  batchUser, firmlyTied, lexicalSimilarity, looksLikeRoundup, pairUser, reportText, sameOccurrence, signalTarget, storyForDevelopment, verdictsByFact,
  type CandidateView, type Relation, type ReportView, type Verdict,
} from "./relate.ts";

export const GROUP_PROMPT_VERSION = RELATE_PROMPT_VERSION;
/** Reports discovered this recently are candidates (keyed on discovery, so an old page found today still meets its peers). */
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
  revision: number;
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

export function participantKey(source: { id: string; signal_group_id: string | null }): string {
  return source.signal_group_id ? `group:${source.signal_group_id}` : `source:${source.id}`;
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
  let occurred = typeof frame?.occurredAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(frame.occurredAt) ? new Date(`${frame.occurredAt}T00:00:00+08:00`) : null;
  if (occurred && (!Number.isFinite(+occurred) || beijingDate(occurred) !== frame!.occurredAt)) occurred = null;
  const [row] = await db<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title, subject, action, object, occurred_at, created_at)
    VALUES (${`f${newShortId(8)}`}, ${storyId}, ${title}, ${frame?.subject ?? null}, ${frame?.action ?? null}, ${frame?.object ?? null}, ${occurred}, ${at})
    RETURNING id`;
  return row!.id;
}

export async function recordSignal(db: Tx, storyId: number, articleId: string, source: { id: string; signal_group_id: string | null }, kind: "editorial" | "signal", observedAt: Date) {
  // All callers write in a transaction: lock the story before inserting evidence, so a concurrent
  // merge either carries this row with it or makes this decision retry against the surviving story.
  const updated = await db`UPDATE stories SET latest_at = GREATEST(coalesce(latest_at, ${observedAt}), ${observedAt}),
              first_report_at = LEAST(coalesce(first_report_at, ${observedAt}), ${observedAt}), updated_at = now()
            WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!updated.count) throw new Error("Grouping target changed; retry against the current story");
  await db`
    INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${storyId}, ${articleId}, ${participantKey(source)}, ${source.id}, ${kind}, ${observedAt})
    ON CONFLICT (story_id, article_id) DO NOTHING`;
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
    if (await manualDecision(tx, articleId)) return [];
    await lockStoryMembership(tx);
    const left = await tx<{ story_id: number }[]>`
      SELECT DISTINCT f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
      WHERE fa.article_id = ${articleId} AND NOT fa.manual AND fa.role IN ('primary', 'report') AND f.story_id IS NOT NULL`;
    const removed = await tx<{ fact_id: number }[]>`DELETE FROM fact_articles WHERE article_id = ${articleId} AND NOT manual RETURNING fact_id`;
    await tx`DELETE FROM story_signals WHERE article_id = ${articleId}`;
    // 仅失效实际移走的自动归属，保留人工归属及其合法文字。
    await invalidateStoryInputs(tx, [], new Date(), removed.map(r => r.fact_id));
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
    SELECT a.id, a.revision, a.title, a.url, a.published_at, a.discovered_at, a.grouped_at, a.body_text, a.x_post, a.backfill,
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

  if (a.participation_mode === "isolated") return { verdict: "skipped" };
  if (opts.signalOnly || a.participation_mode !== "editorial") return groupSignal(a, source, observedAt);
  const [publication] = await sql<{ title: string; summary: string | null; visibility: string }[]>`
    SELECT title,summary,visibility FROM publications WHERE article_id=${articleId}`;
  if (publication && publication.visibility !== "public") return { verdict: "standalone" };

  const kept = await currentMembership(articleId);
  if (kept) {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "kept", factId: kept.factId, storyId: kept.storyId };
  }

  const [an] = await sql<{ id: number; relevance: string | null; title_zh: string | null; summary_zh: string | null; output: Record<string, any> | null }[]>`
    SELECT id, relevance, title_zh, summary_zh, output FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  // 人工更正优先；旧analysis的事件框架不能把被改掉的主张重新带回来。
  const corrected = !!publication && (publication.title !== an?.title_zh || publication.summary !== an?.summary_zh);
  const frame = (corrected ? null : an?.output?.fact ?? null) as Record<string, any> | null;
  if (!an || an.relevance !== "pass") {
    await markGrouped(articleId);
    await publishArticle(articleId);
    return { verdict: "standalone" };
  }
  const title = publication?.title || an.title_zh || a.title;
  const summary = publication ? publication.summary : an.summary_zh;
  const query: ReportView = {
    title, source: a.source_name, firstParty: a.first_party, at: observedAt, summary,
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
      cands = await candidateViews(await recallFacts(articleId, reportText(title, summary), RECALL_MIN_COSINE, RECALL_TOP_FACTS, referenced));
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
    await lockStoryMembership(tx);
    const [current] = await tx<{ revision: number; mode: string; title: string | null; summary: string | null; visibility: string; analysis_id: number | null }[]>`
      SELECT a.revision,s.participation_mode AS mode,p.title,p.summary,coalesce(o.visibility,p.visibility,'public') AS visibility,
        (SELECT id FROM analyses WHERE article_id=a.id ORDER BY input_revision DESC,id DESC LIMIT 1) AS analysis_id
      FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN publications p ON p.article_id=a.id
      LEFT JOIN editorial_overrides o ON o.article_id=a.id WHERE a.id=${articleId}`;
    // 与撤回共用article锁，来源隔离/合并共用成员锁；晚到模型不得创建旧文字副本。
    if (!current || current.mode !== "editorial" || current.visibility !== "public" || current.revision !== a.revision ||
        current.analysis_id !== an.id || current.title !== (publication?.title ?? null) || current.summary !== (publication?.summary ?? null)) {
      return { manual: null, factId: null, storyId: null };
    }
    if (storyId !== null) {
      const [currentStory] = await tx`SELECT id FROM stories WHERE id = ${storyId} AND merged_into IS NULL FOR UPDATE`;
      if (!currentStory) throw new Error("Grouping target changed; retry against the current story");
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
  if (!written.storyId || !written.factId) return { verdict: "standalone" };
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
      result.rematched = await rematchSignals(articleId, reportText(title, summary));
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
  // Discussion evidence obeys the same article lock and last-minute manual check as reports. The
  // evidence and decision commit together; a retry cannot leave half of a signal attached.
  const write = async (target: { factId: number; storyId: number } | null, verdict: "signal" | "signal-native" | "signal-unmatched", candidates: DecisionCandidate[], receiptId: number | null = null): Promise<GroupResult> => {
    return sql.begin(async (tx) => {
      await tx`SELECT 1 FROM articles WHERE id = ${a.id} FOR UPDATE`;
      const manual = await manualDecision(tx, a.id);
      if (!manual) {
        if (target) await recordSignal(tx, target.storyId, a.id, source, "signal", observedAt);
        await recordDecision(tx, a.id, target?.factId ?? null, target?.storyId ?? null, verdict, candidates, receiptId);
      }
      if (receiptId !== null) await completeReceipt(tx, receiptId);
      return manual ? { verdict: "manual", factId: manual.factId } : { verdict, ...(target ? { storyId: target.storyId } : {}) };
    });
  };
  const { referenced } = await relatedPosts(a);
  if (referenced.length) {
    const target = referenced[0]!;
    return write({ factId: target.fact_id, storyId: target.story_id }, "signal-native", [{ id: target.fact_id, score: 1, relation: "SAME_STORY", confidence: 1 }]);
  }
  if (!embeddingsAvailable()) return { verdict: "signal-unmatched" };
  const recalled = await recallFacts(a.id, signalText(a), SIGNAL_MIN_COSINE, SIGNAL_TOP_FACTS);
  if (recalled.length === 0) {
    // Recorded, so a post that found nothing is told apart from one never decided.
    return write(null, "signal-unmatched", []);
  }
  const top = recalled[0]!;
  const asCandidates = (verdicts?: Map<number, Verdict>): DecisionCandidate[] =>
    recalled.map((r) => ({ id: r.factId, score: Math.round(r.score * 1000) / 1000, relation: verdicts?.get(r.factId)?.relation, confidence: verdicts?.get(r.factId)?.confidence }));
  if (top.score >= SIGNAL_AUTO_COSINE) {
    return write(top, "signal", asCandidates());
  }
  const cands = await candidateViews(recalled);
  if (cands.length === 0) return { verdict: "signal-unmatched" };
  const query: ReportView = { title: a.title, source: a.source_name, firstParty: false, at: observedAt, summary: a.body_text?.slice(0, 300) ?? null };
  const { verdicts, receiptId } = await judgeSignal(a.id, query, cands);
  const target = signalTarget(cands, verdicts);
  return write(target, target ? "signal" : "signal-unmatched", asCandidates(verdicts), receiptId);
}
