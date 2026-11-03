// One piece of news, one card. A card is what a reader sees; everything else in grouping is a guess at
// which reports belong together, made once, as they arrive, against a fact's first report. So the
// moment a report is about to open a new card, it is compared directly with the cards around it, as a
// reader sees them. When both models see the same occurrence the report does not open one: it joins
// the fact of that card, or, having no fact to join (history, a composite) or facing a card with none,
// stays readable in 全部动态. On a month of real cards the pair prompt that already decides merges
// found such repeats at precision 0.93 and recall 0.88 from this similarity up; most of them were
// history and composites, which no other step ever compared with a card.
import { modelRoute } from "../editorial/models.ts";
import { sql, type Tx } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { republishTx } from "../publication/publish.ts";
import { echoesOfIndependent, independentOfEcho, independentSelectedSources, isIndependentSelectedSource } from "../publication/rules.ts";
import { foldableSelectionCondition, seatedCondition } from "../publication/scope.ts";
import { recallCards, type CardRow } from "./recall.ts";
import { PAIR_SYSTEM, PairSchema, RELATE_PROMPT_VERSION, STORY_REVIEW_MIN_CONFIDENCE, TIE_MIN_CONFIDENCE, pairUser, reportText, type ReportView } from "./relate.ts";

/** Below this, two reports of one piece of news are rare and analyses of one filing common. */
const CARD_MIN_COSINE = 0.78;
const CARD_TOP = 5;

export interface Reader {
  articleId: string;
  sourceId: string;
  /** Title, source, time and summary only: what the reader sees, on both sides of the comparison. */
  view: ReportView;
  text: string;
  at: Date;
}

/**
 * A report as it would reach readers, or null when it will not: only one scoring nominated and no
 * editor took out can open a card, so only it pays for the comparison.
 */
export async function readerOf(articleId: string): Promise<Reader | null> {
  const [row] = await sql<{
    source_id: string; source: string; first_party: boolean; title: string; title_zh: string | null; summary_zh: string | null;
    timeline_at: Date; published_at: Date | null; publication_time: string | null;
  }[]>`
    SELECT a.source_id, s.name AS source, (s.tier = 'T1') AS first_party, a.title, an.title_zh, an.summary_zh, a.timeline_at, a.published_at, a.publication_time
    FROM articles a JOIN sources s ON s.id = a.source_id
    JOIN LATERAL (SELECT title_zh, summary_zh, selected FROM analyses x WHERE x.article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
    LEFT JOIN editorial_overrides o ON o.article_id = a.id
    WHERE a.id = ${articleId} AND s.participation_mode = 'editorial' AND an.selected
      AND coalesce(o.visibility, 'public') = 'public' AND coalesce(o.fields->>'selected', 'true') <> 'false'`;
  if (!row) return null;
  const title = row.title_zh || row.title;
  return {
    articleId, sourceId: row.source_id, text: reportText(title, row.summary_zh), at: row.timeline_at,
    view: { title, source: row.source, firstParty: row.first_party, at: row.published_at, publicationTime: row.publication_time, summary: row.summary_zh },
  };
}

/** Why a report stays out of 精选: the title is what the reader has already seen. */
export const alreadyOnCard = (title: string) => `读者已在精选看过同一条新闻：${title}`;

/** The review model reads the pair the other way round. */
async function sameNews(reader: Reader, card: CardRow): Promise<boolean> {
  const subject = `article:${reader.articleId}:card:${card.article_id}`;
  const shown: ReportView = { title: card.title, source: card.source, firstParty: card.firstParty, at: card.at, publicationTime: card.publicationTime, summary: card.summary };
  const first = await chatJson({
    ...await modelRoute("group"), purpose: "group_card", subject, promptVersion: RELATE_PROMPT_VERSION,
    system: PAIR_SYSTEM, user: pairUser(shown, reader.view), schema: PairSchema, temperature: 0, maxTokens: 400,
  });
  await completeReceipt(sql, first.receiptId);
  if (first.data.relation !== "SAME_OCCURRENCE" || first.data.confidence < TIE_MIN_CONFIDENCE) return false;
  const second = await chatJson({
    ...await modelRoute("groupReview"), purpose: "group_card_review", subject, promptVersion: RELATE_PROMPT_VERSION,
    system: PAIR_SYSTEM, user: pairUser(reader.view, shown), schema: PairSchema, temperature: 0, maxTokens: 400,
  });
  await completeReceipt(sql, second.receiptId);
  return second.data.relation === "SAME_OCCURRENCE" && second.data.confidence >= STORY_REVIEW_MIN_CONFIDENCE;
}

const recall = (reader: Reader, ownFact: number | null, sources: { skip?: string[]; only?: string[] }) =>
  recallCards(reader.articleId, reader.text, reader.at, ownFact, sources, CARD_MIN_COSINE, CARD_TOP);

async function firstSame(reader: Reader, cards: CardRow[]): Promise<CardRow | null> {
  for (const card of cards) if (await sameNews(reader, card)) return card;
  return null;
}

/** Whether a fact already has a card its other reports fold under. */
export async function factHasCard(factId: number): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM publications p WHERE p.fact_id = ${factId} AND ${seatedCondition(new Date())} AND ${foldableSelectionCondition()} LIMIT 1`;
  return !!row;
}

/**
 * The card already telling this report's news, or null. An independent source keeps its own card
 * beside the fact's, so ordinary reports do not compare with it. Asked before anything is written: a
 * failed call leaves the report waiting, not a duplicate out.
 */
export async function seenOnCard(reader: Reader, ownFact: number | null): Promise<CardRow | null> {
  return firstSame(reader, await recall(reader, ownFact, { skip: independentSelectedSources() }));
}

/** The card of the author's own article telling this post's news, whatever fact the two share. */
export async function ownArticleOnCard(reader: Reader): Promise<CardRow | null> {
  const article = independentOfEcho(reader.sourceId);
  return article ? firstSame(reader, await recall(reader, null, { only: [article] })) : null;
}

/** The cards an independent source's article replaces: its author's posts telling the same news. */
export async function echoesOnCard(reader: Reader): Promise<CardRow[]> {
  const only = echoesOfIndependent(reader.sourceId);
  if (!only.length) return [];
  const echoes: CardRow[] = [];
  for (const card of await recall(reader, null, { only })) if (await sameNews(reader, card)) echoes.push(card);
  return echoes;
}

/** A card gives way to the one telling its news: it stays readable in 全部动态. */
export async function retireCardTx(tx: Tx, articleId: string, title: string): Promise<void> {
  await tx`UPDATE articles SET selection_adds_value = false, selection_value_reason = ${alreadyOnCard(title)} WHERE id = ${articleId}`;
  await republishTx(tx, articleId);
}

/** Whether a report folds under the card: an independent card keeps its place beside the fact's. */
export const foldsUnder = (card: CardRow): card is CardRow & { fact_id: number; story_id: number } =>
  card.fact_id !== null && card.story_id !== null && !isIndependentSelectedSource(card.source_id);
