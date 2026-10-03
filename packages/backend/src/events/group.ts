// Event grouping. A report attaches to a fact, the same real-world occurrence, and
// facts hang on a story, an occurrence with its direct developments. Recall (recall.ts): the same
// title-and-summary embedding on both sides over the reports of the last 14 days (shared bigrams
// without an embedding key), plus the same URL and the X post a post replies to or quotes.
// Identity: one three-way relation judgement over the candidate
// facts with their representative reports fully described (relate.ts); a merge that is not obvious
// from similarity is confirmed by a second vendor before it is written; a development attaches only
// to the fact that started its story, so stories do not grow by chaining. Manual corrections
// (corrections.ts) are never overwritten; a revision keeps its membership unless an editor asks for a regroup or its
// structure identifies it as composite. Composite material only mentions facts, never starts or
// joins a fact/story and never supplies a root or bridge. When a
// report is firmly tied to two stories, their roots are compared directly and the stories merge
// when both models see one story (consolidate.ts); stories that stay apart though reports keep tying
// them list each other as related (linkRelatedStories). A story a regrouped report leaves without
// reports merges into where it went, so its address keeps working. Discussion posts that found no
// story get another look when a report founds a fact close to them (rematchSignals); history
// (isHistorical) founds no event. Runs serially (queue concurrency 1).
import { modelFor } from "../editorial/models.ts";
import { beijingDate } from "@aihot/contracts/time";
import { sql, type Db, type Tx } from "../db.ts";
import { newShortId, newUuid } from "../lib/ids.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { embeddingsAvailable } from "../providers/embeddings.ts";
import { isHistorical, STALE_ON_DISCOVERY_MS } from "../content/materials.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { publishArticle, publishArticleTx } from "../publication/publish.ts";
import { latestCompositeCondition } from "../publication/scope.ts";
import { consolidate, liveStory, type Consolidation } from "./consolidate.ts";
import { mergeStoryInto } from "./merge.ts";
import { candidateViews, cosine32, recallFacts, recallSelectedBackground, relatedPosts, vectorsFor } from "./recall.ts";
import {
  BATCH_SYSTEM, BATCH_PROMPT_VERSION, BatchSchema, PAIR_SYSTEM, PairSchema, RELATE_PROMPT_VERSION, SIGNAL_SYSTEM, SignalSchema, TIE_MIN_CONFIDENCE,
  batchUser, completeDecisions, firmlyTied, pairUser, reportText, sameOccurrence, signalTarget, storyForDevelopment, verdictsByFact,
  type CandidateView, type ReadingContext, type Relation, type ReportView, type SelectionValue, type Verdict,
} from "./relate.ts";

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
  backfill: boolean;
}

/**
 * The participant as recorded when the signal was written. Heat reads the participant from the current
 * source (events/hot.ts currentSignals), so a later change of group or owner reaches it at once.
 */
function participantKey(source: { id: string; signal_group_id: string | null }): string {
  return source.signal_group_id ? `group:${source.signal_group_id}` : `source:${source.id}`;
}

// Judgement

const NO_SELECTED_COVERAGE: SelectionValue = { addsValue: true, reason: "没有已公开精选的相关报道" };

async function judgeBatch(articleId: string, query: ReportView, cands: CandidateView[], reading: ReadingContext[]): Promise<{ verdicts: Map<number, Verdict>; selection: SelectionValue; receiptId: number }> {
  const res = await chatJson({
    model: await modelFor("group"), purpose: "group_article", subject: `article:${articleId}`, promptVersion: BATCH_PROMPT_VERSION,
    system: BATCH_SYSTEM, user: batchUser(query, cands, "新报道", reading), schema: BatchSchema.refine(value => completeDecisions(value.decisions, cands.length), "Every candidate requires exactly one decision"), temperature: 0, maxTokens: 400 + 120 * cands.length,
  });
  return { verdicts: verdictsByFact(res.data.decisions, cands), selection: cands.some(c => c.selected) || reading.length ? res.data.selection : NO_SELECTED_COVERAGE, receiptId: res.receiptId };
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
    system: SIGNAL_SYSTEM, user: batchUser(query, cands, "帖子"), schema: SignalSchema.refine(value => completeDecisions(value.decisions, cands.length), "Every candidate requires exactly one decision"), temperature: 0, maxTokens: 150 + 60 * cands.length,
  });
  return { verdicts: verdictsByFact(res.data.decisions, cands), receiptId: res.receiptId };
}

// Writes

async function createStory(db: Db, title: string, at: Date): Promise<number> {
  const [row] = await db<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at, origin)
    VALUES (${newUuid()}, ${title}, ${at}, ${at}, 'model') RETURNING id`;
  return row!.id;
}

async function createFact(db: Db, storyId: number, title: string, frame: Record<string, any> | null, at: Date): Promise<number> {
  let occurred = typeof frame?.occurredAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(frame.occurredAt) ? new Date(`${frame.occurredAt}T00:00:00+08:00`) : null;
  if (occurred && (!Number.isFinite(+occurred) || beijingDate(occurred) !== frame!.occurredAt)) occurred = null;
  const conditions = Array.isArray(frame?.conditions) ? frame.conditions.map((c: { text?: string }) => c.text).filter(Boolean).join("；") || null : null;
  const [row] = await db<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title, subject, action, object, conditions, occurred_at, created_at)
    VALUES (${`f${newShortId(8)}`}, ${storyId}, ${title}, ${frame?.subject ?? null}, ${frame?.action ?? null}, ${frame?.object ?? null}, ${conditions}, ${occurred}, ${at})
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
 * A clean slate (an editor's regroup, a composite, material too thin for an identity): automatic
 * memberships and heat evidence go, manual ones stay. Returns the stories the report was a report
 * of. The caller holds the article's row lock.
 */
export async function resetAutomatic(tx: Tx, articleId: string): Promise<number[]> {
  if (await manualDecision(tx, articleId)) return [];
  const left = await tx<{ story_id: number }[]>`
    SELECT DISTINCT f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    WHERE fa.article_id = ${articleId} AND NOT fa.manual AND fa.role IN ('primary', 'report') AND f.story_id IS NOT NULL`;
  await tx`DELETE FROM fact_articles WHERE article_id = ${articleId} AND NOT manual`;
  await tx`DELETE FROM story_signals WHERE article_id = ${articleId}`;
  return left.map((r) => Number(r.story_id));
}

/**
 * Stories the report sat in before (its earlier decisions) that hold no report now keep their
 * address: each merges into the report's story, so its public id redirects there.
 */
async function redirectEmptiedStories(articleId: string, storyId: number): Promise<number[]> {
  const emptied = await sql<{ id: number }[]>`
    SELECT st.id FROM stories st
    WHERE st.id IN (SELECT d.story_id FROM grouping_decisions d WHERE d.article_id = ${articleId})
      AND st.id <> ${storyId} AND st.merged_into IS NULL
      AND NOT EXISTS (SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id WHERE f.story_id = st.id AND fa.role IN ('primary', 'report'))`;
  const redirected: number[] = [];
  for (const { id } of emptied) {
    if (await mergeStoryInto(Number(id), storyId, `报道已全部移走，旧地址跳到报道所在事件（最后一篇 ${articleId}）`, "grouping")) redirected.push(Number(id));
  }
  return redirected;
}

class GroupingSupersededError extends Error {}

async function lockCurrentRevision(db: Db, articleId: string, revision: number) {
  const [current] = await db<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (current?.revision !== revision) throw new GroupingSupersededError("Grouping input changed; the replacement revision has its own analysis");
}

async function markGrouped(articleId: string, revision: number, selection?: SelectionValue, db: Db = sql) {
  const done = await db`UPDATE articles SET grouped_at = coalesce(grouped_at, now()), grouping_status = 'complete', grouping_receipt_id = NULL, grouping_error = NULL,
    selection_adds_value = CASE WHEN ${!!selection} THEN ${selection?.addsValue ?? null} ELSE selection_adds_value END,
    selection_value_reason = CASE WHEN ${!!selection} THEN ${selection?.reason ?? null} ELSE selection_value_reason END
    WHERE id = ${articleId} AND revision = ${revision}`;
  if (!done.count) throw new GroupingSupersededError("Grouping input changed; the replacement revision has its own analysis");
}

// Entry

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
}

export async function groupArticle(articleId: string, opts: GroupOptions = {}): Promise<GroupResult> {
  const input = await sql.begin(async tx => {
    const [current] = await tx<{ revision: number; grouping_status: string; selection_adds_value: boolean | null }[]>`
      SELECT revision, grouping_status, selection_adds_value FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!current) return null;
    await tx`UPDATE articles SET grouping_status = 'pending', grouped_at = NULL, grouping_error = NULL, grouping_receipt_id = NULL WHERE id = ${articleId}`;
    // An unfinished decision (new material, a failure, an explicit regroup) must withdraw its old public
    // seat in this transaction. Ordinary repeats of a completed identity reuse it immediately without
    // a transient withdrawal.
    if (current.grouping_status !== 'complete') await publishArticleTx(tx, articleId);
    return current;
  });
  if (!input) return { verdict: "skipped" };
  const revision = input.revision;
  try {
    const result = await decide(articleId, opts, revision, input.grouping_status !== 'complete' && input.selection_adds_value === null);
    await markGrouped(articleId, revision);
    await publishArticle(articleId);
    return result;
  } catch (error) {
    const receiptId = error && typeof error === 'object' && 'receiptId' in error && typeof error.receiptId === 'number' ? error.receiptId : null;
    // A late failed model call must not undo an editor's completed decision, or a fact already
    // committed before an optional downstream operation failed. Shutdown leaves work pending.
    await sql`UPDATE articles SET grouping_status = ${shutdownSignal.signal.aborted ? 'pending' : 'failed'},
      grouped_at = NULL, grouping_receipt_id = ${receiptId}, grouping_error = ${String(error).slice(0, 2000)}
      WHERE id = ${articleId} AND revision = ${revision} AND grouping_status <> 'complete' AND ${!(error instanceof GroupingSupersededError)}`;
    await publishArticle(articleId);
    throw error;
  }
}

async function decide(articleId: string, opts: GroupOptions, revision: number, recheckSelection: boolean): Promise<GroupResult> {
  const [a] = await sql<ArticleRow[]>`
    SELECT a.id, a.revision, a.title, a.url, a.published_at, a.discovered_at, a.grouped_at, a.body_text, a.x_post, a.backfill,
           s.id AS source_id, s.name AS source_name, s.signal_group_id, (s.tier = 'T1') AS first_party, s.participation_mode
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (a && a.revision !== revision) throw new GroupingSupersededError("Grouping input changed before it was read");
  if (!a) return { verdict: "skipped" };
  const observedAt = a.published_at ?? a.discovered_at;
  const source = { id: a.source_id, signal_group_id: a.signal_group_id };

  // Manual decisions win over any model decision: a manual membership, or "keep standalone".
  const manual = await manualDecision(sql, articleId);
  if (manual) {
    await markGrouped(articleId, a.revision, { addsValue: true, reason: "人工确认的归属" });
    return { verdict: "manual", factId: manual.factId };
  }
  const [an] = await sql<{ input_revision: number; relevance: string | null; title_zh: string | null; summary_zh: string | null; output: Record<string, any> | null; composite: boolean }[]>`
    SELECT input_revision, relevance, title_zh, summary_zh, output, ${latestCompositeCondition(sql`${articleId}`)} AS composite
    FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  if (an && an.input_revision !== a.revision && a.participation_mode === "editorial") {
    throw new GroupingSupersededError("Current material revision is still waiting for analysis");
  }
  const composite = an?.composite === true;
  const unsupported = an?.output?.scope === "unknown" && !an.output.fact;
  const left = composite || unsupported
    ? await sql.begin(async (tx) => { await lockCurrentRevision(tx, articleId, a.revision); return resetAutomatic(tx, articleId); })
    : [];

  // History founds no event and adds no heat (isHistorical); a regroup takes it out of any it joined.
  if (isHistorical(a)) {
    await markGrouped(articleId, a.revision, { addsValue: true, reason: "历史资料按原文时间归档" });
    return { verdict: "historical" };
  }

  if (opts.signalOnly || a.participation_mode !== "editorial") return groupSignal(a, source, observedAt);

  // Explicitly insufficient material supplies no event identity. A missing (older) scope is separate.
  if (unsupported) {
    await markGrouped(articleId, a.revision, { addsValue: false, reason: "材料不足以确认当前消息" });
    return { verdict: "standalone" };
  }

  const kept = await currentMembership(articleId);
  // A material revision clears its value decision, but keeps its established membership. Reuse
  // that identity after judging the replacement material below; ordinary repeats and confirmed
  // nulls from before the value check keep their existing value without buying another judgement.
  if (kept && !recheckSelection) {
    await markGrouped(articleId, a.revision);
    return { verdict: "kept", factId: kept.factId, storyId: kept.storyId };
  }

  const frame = (an?.output?.fact ?? null) as Record<string, any> | null;
  if (!an || an.relevance !== "pass") {
    await markGrouped(articleId, a.revision, { addsValue: false, reason: "未通过内容分析" });
    return { verdict: "standalone" };
  }
  const title = an.title_zh || a.title;
  const query: ReportView = {
    title, source: a.source_name, firstParty: a.first_party, at: observedAt, summary: an.summary_zh,
    scope: composite ? "composite" : an.output?.scope === "single" ? "single" : "unknown",
    frame: frame ? { subject: frame.subject, action: frame.action, object: frame.object, occurredAt: frame.occurredAt } : null,
  };
  const newTitle = String(frame?.title || title).slice(0, 60);

  const { sameUrl, referenced } = await relatedPosts(a);
  // The URL settles identity, but an unseen fact still needs its first reading-value decision.
  const selectedSameUrl = sameUrl && !composite && !kept && (await candidateViews([{
    factId: sameUrl.fact_id, storyId: sameUrl.story_id, factTitle: sameUrl.fact_title, score: 1,
  }]))[0]?.selected === true;
  const cands = selectedSameUrl ? [] : await candidateViews(await recallFacts(articleId,
    reportText(title, an.summary_zh), RECALL_MIN_COSINE, RECALL_TOP_FACTS, [...referenced, ...(sameUrl ? [sameUrl] : [])]));
  const reading = selectedSameUrl ? [] : await recallSelectedBackground(articleId, reportText(title, an.summary_zh), RECALL_MIN_COSINE);
  let verdicts = new Map<number, Verdict>();
  let selection = NO_SELECTED_COVERAGE;
  const receipts: number[] = [];
  if (cands.length || reading.length) {
    const judged = await judgeBatch(articleId, { ...query, sourceText: a.body_text }, cands, reading);
    verdicts = judged.verdicts;
    selection = judged.selection;
    receipts.push(judged.receiptId);
  }
  if (composite) {
    // Use the existing batch judgement only to find mentions. Even a mistaken SAME_OCCURRENCE
    // answer cannot give a composite a primary/report membership or trigger consolidation.
    const receiptId = receipts[0] ?? null;
    const late = await sql.begin(async (tx) => {
      await lockCurrentRevision(tx, articleId, a.revision);
      const manual = await manualDecision(tx, articleId);
      if (manual) return manual;
      for (const c of cands) {
        const v = verdicts.get(c.factId);
        if (v && v.relation !== "UNRELATED" && v.confidence >= TIE_MIN_CONFIDENCE) {
          await tx`INSERT INTO fact_articles (fact_id, article_id, role, created_at) VALUES (${c.factId}, ${articleId}, 'mention', ${observedAt})
                   ON CONFLICT (fact_id, article_id) DO NOTHING`;
        }
      }
      await recordDecision(tx, articleId, null, null, "roundup", cands.map((c) => ({ id: c.factId, score: c.score, ...verdicts.get(c.factId) })), receiptId);
      await markGrouped(articleId, a.revision, selection, tx);
      return null;
    });
    if (receiptId !== null) await completeReceipt(sql, receiptId);
    // A newly identified composite may have supplied an older digest. Rebuild its former stories
    // from their remaining reports, without redirecting an emptied story into an unrelated one.
    for (const id of left) await enqueue(QUEUES.digest, { storyId: id }, { singletonKey: `story:${id}` });
    return late ? { verdict: "manual", factId: late.factId } : { verdict: "roundup" };
  }
  if (kept) {
    // A sibling already selected for this same fact still permits representative replacement.
    if (cands.some(c => c.factId === kept.factId && c.selected)) selection = { addsValue: true, reason: "同一新闻的代表报道候选" };
    const late = await sql.begin(async tx => {
      await lockCurrentRevision(tx, articleId, a.revision);
      const manual = await manualDecision(tx, articleId);
      await markGrouped(articleId, a.revision, manual ? { addsValue: true, reason: "人工确认的归属" } : selection, tx);
      if (!manual) await recordDecision(tx, articleId, kept.factId, kept.storyId, "kept",
        cands.map(c => ({ id: c.factId, score: c.score, ...verdicts.get(c.factId) })), receipts[0] ?? null);
      return manual;
    });
    for (const receiptId of receipts) await completeReceipt(sql, receiptId);
    return late ? { verdict: "manual", factId: late.factId } : { verdict: "kept", factId: kept.factId, storyId: kept.storyId };
  }
  let verdict: GroupResult["verdict"] = "new-story";
  let factId: number | null = null;
  let storyId: number | null = null;

  if (sameUrl) {
    verdict = "same-url";
    factId = sameUrl.fact_id;
    storyId = sameUrl.story_id;
  } else {
    if (cands.length) {
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
        }
      }
    }
  }

  const decisionCandidates: DecisionCandidate[] = cands.map((c) => ({
    id: c.factId, score: Math.round(c.score * 1000) / 1000, relation: verdicts.get(c.factId)?.relation, confidence: verdicts.get(c.factId)?.confidence,
  }));
  if (sameUrl) decisionCandidates.push({ id: sameUrl.fact_id, score: 1, relation: "SAME_OCCURRENCE", confidence: 1 });
  // Only a fact already shown in selected has a representative slot to replace. A duplicate of
  // an unselected fact must retain the value judgement, including a prior low-increment rejection.
  if ((verdict === "same-fact" || verdict === "same-url") && (selectedSameUrl || cands.some(c => c.factId === factId && c.selected))) {
    selection = { addsValue: true, reason: "同一新闻的代表报道候选" };
  }

  // Written under the article's row lock after reading the manual state again: a detach or other
  // manual decision made while the model was answering wins (detachFromFact takes the same lock).
  const written = await sql.begin(async (tx) => {
    await lockCurrentRevision(tx, articleId, a.revision);
    const late = await manualDecision(tx, articleId);
    if (late) {
      await markGrouped(articleId, a.revision, { addsValue: true, reason: "人工确认的归属" }, tx);
      return { manual: late, factId: null, storyId: null };
    }
    if (storyId !== null) {
      const [current] = await tx`SELECT id FROM stories WHERE id = ${storyId} AND merged_into IS NULL FOR UPDATE`;
      if (!current) throw new Error("Grouping target changed; retry against the current story");
    }
    const story = storyId ?? (await createStory(tx, newTitle, observedAt));
    const fact = factId ?? (await createFact(tx, story, newTitle, frame, observedAt));
    const [hasPrimary] = await tx<{ n: number }[]>`SELECT count(*) AS n FROM fact_articles WHERE fact_id = ${fact} AND role = 'primary'`;
    const role = a.first_party && Number(hasPrimary?.n ?? 0) === 0 ? "primary" : "report";
    const evidence = [frame?.evidence, ...(Array.isArray(frame?.conditions) ? frame.conditions.map((c: { quote?: string }) => c.quote) : [])].filter((x): x is string => typeof x === "string" && !!x).join("\n") || null;
    await tx`INSERT INTO fact_articles (fact_id, article_id, role, evidence, created_at) VALUES (${fact}, ${articleId}, ${role}, ${evidence}, ${observedAt}) ON CONFLICT (fact_id, article_id) DO NOTHING`;
    await recordSignal(tx, story, articleId, source, "editorial", observedAt);
    await recordDecision(tx, articleId, fact, story, verdict, decisionCandidates, receipts[0] ?? null);
    await markGrouped(articleId, a.revision, selection, tx);
    return { manual: null, factId: fact, storyId: story };
  });
  for (const id of receipts) await completeReceipt(sql, id);
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
  const redirected = await redirectEmptiedStories(articleId, result.storyId!);
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
/** How long a discussion post waits for the post it replies to or quotes. */
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
    if (!v || cosine32(mine, v) < SIGNAL_MIN_COSINE) continue;
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
      await lockCurrentRevision(tx, a.id, a.revision);
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
