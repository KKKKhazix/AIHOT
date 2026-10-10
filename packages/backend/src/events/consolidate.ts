// Story consolidation (group.ts calls it after a decision). Stories a report is firmly tied to may be
// one story that grew two roots: their roots are compared directly and merge only when both models
// see one story. Stories that stay apart though reports keep tying them list each other as related
// events (linkRelatedStories, hourly).
import { modelFor } from "../editorial/models.ts";
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { groupingEvidenceCondition } from "../publication/scope.ts";
import { mergeStoryInto } from "./merge.ts";
import { RECALL_DAYS, rootFactOf } from "./recall.ts";
import { RELATED_MIN_REPORTS } from "./related.ts";
import {
  PAIR_SYSTEM, PairSchema, RELATE_PROMPT_VERSION, STORY_REVIEW_MIN_CONFIDENCE, TIE_MIN_CONFIDENCE, firmlyTied, pairUser,
  type Relation, type ReportView,
} from "./relate.ts";

interface StoryRoot {
  storyId: number;
  at: Date;
  /** The story started as a multi-topic digest: never merged. */
  roundup: boolean;
  report: ReportView;
}

/** A model-managed story's root; editor-confirmed identities are excluded before paid comparison. */
async function storyRoot(storyId: number): Promise<StoryRoot | null> {
  const [row] = await sql<{
    subject: string | null; action: string | null; object: string | null; occurred_at: Date | null;
    title: string; summary: string | null; source: string; first_party: boolean; at: Date; started_at: Date; roundup: boolean;
  }[]>`
    SELECT f.subject, f.action, f.object, f.occurred_at, p.title, p.summary, s.name AS source, (s.tier = 'T1') AS first_party,
           coalesce(p.published_at, p.discovered_at) AS at,
           (SELECT min(coalesce(q.published_at, q.discovered_at)) FROM fact_articles z JOIN publications q ON q.article_id = z.article_id
            WHERE z.fact_id = f.id AND z.role IN ('primary', 'report') AND ${groupingEvidenceCondition(sql`z.article_id`)}) AS started_at,
           EXISTS (SELECT 1 FROM grouping_decisions d WHERE d.article_id = fa.article_id AND d.verdict = 'roundup') AS roundup
    FROM facts f
    JOIN stories st ON st.id = f.story_id AND st.origin <> 'manual'
    JOIN fact_articles fa ON fa.fact_id = f.id AND fa.role IN ('primary', 'report') AND ${groupingEvidenceCondition(sql`fa.article_id`)}
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
      frame: { subject: row.subject, action: row.action, object: row.object, occurredAt: row.occurred_at ? beijingDate(row.occurred_at) : null },
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

export async function liveStory(id: number): Promise<number | null> {
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
  /** Both models saw one story and the two merged. */
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
export async function consolidate(storyIds: number[]): Promise<Consolidation[]> {
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
    const merge = firmlyTied(second.relation, second.confidence, STORY_REVIEW_MIN_CONFIDENCE)
      && !!await mergeStoryInto(other.storyId, anchor.storyId, `同一事件（${first.relation}，复核 ${second.relation}）：${other.report.title}｜${anchor.report.title}`, "grouping");
    out.push({ ...base, merge, first: first.relation, second: second.relation, difference: first.difference || second.difference });
  }
  return out;
}

/**
 * A multi-topic digest is a report of the story's root fact (digests now only mention facts, so this
 * marks older stories; one that mentions the root does not count): the story is neither merged nor
 * linked.
 */
const startedByRoundup = (story: ReturnType<typeof sql>) => sql`EXISTS (
  SELECT 1 FROM fact_articles r JOIN grouping_decisions d ON d.article_id = r.article_id AND d.verdict = 'roundup'
  WHERE r.fact_id = ${rootFactOf(story)} AND r.role <> 'mention' AND ${groupingEvidenceCondition(sql`r.article_id`)})`;

/**
 * Stories that stay apart although reports tie them (a reaction, a development of a later fact, a
 * comparison) list each other as related events: at least two reports decided in the recall window,
 * each firmly tied to a fact of the other story, none of them a roundup, neither story started by
 * one. A single tie is too often a stray answer about one candidate among many. Links are only
 * added; public reads check saved bridge evidence after explicit changes, independently of the
 * recall window. A merged story drops out where links are read.
 */
export async function linkRelatedStories(): Promise<{ added: number }> {
  const [row] = await sql<{ added: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (article_id) article_id, verdict, candidates FROM grouping_decisions
      WHERE created_at > now() - make_interval(days => ${RECALL_DAYS}) ORDER BY article_id, id DESC),
    ties AS (
      SELECT DISTINCT l.article_id, own.story_id AS a, other.story_id AS b
      FROM latest l
      JOIN fact_articles fa ON fa.article_id = l.article_id AND fa.role IN ('primary', 'report') AND ${groupingEvidenceCondition(sql`fa.article_id`)}
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
