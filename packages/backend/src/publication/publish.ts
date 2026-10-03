// Publishing: derive the public projection of one article from its material, the latest judgement,
// manual overrides and grouping, then record selected-set changes in the sync ledger.
// Rebuilding only re-reads stored results; it never calls a model.
import { toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/site";
import { one, sql, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { itemUrl } from "./links.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeIdentity } from "./representative.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import {
  bodyModeOf, channelOf, displayTags, isIndexable, isPoolEligible, isSelectable, mayRedistribute, publicSourceName, type SourceFacts,
} from "./rules.ts";
import { latestCompositeCondition, ownFactEvidenceCondition } from "./scope.ts";

interface ArticleRow {
  id: string;
  source_id: string;
  url: string;
  title: string;
  language: string | null;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  body_status: string;
  body_text: string | null;
  x_post: unknown;
  grouped_at: Date | null;
  grouping_status: "pending" | "complete" | "failed";
  selection_adds_value: boolean | null;
}

interface AnalysisRow {
  id: number;
  relevance: string | null;
  category: string | null;
  tags: string[];
  subjects: string[];
  title_zh: string | null;
  summary_zh: string | null;
  reason_zh: string | null;
  score: number | null;
  selected: boolean | null;
}

interface OverrideRow {
  fields: Record<string, unknown>;
  visibility: string | null;
}

interface PublicationRow {
  article_id: string;
  source_id: string;
  first_party: boolean;
  revision: number;
  visibility: string;
  eligible: boolean;
  selected: boolean;
  selection_candidate: boolean;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  body_mode: string;
  story_id: number | null;
  fact_id: number | null;
  selected_ready_at: Date | null;
  visible_after: Date | null;
  indexable: boolean;
  seo_indexed_at: Date | null;
  seo_excluded_at: Date | null;
}

export interface V1ItemPayload {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: { name: string };
  links: { aihot: string; original: string };
  publishedAt: string | null;
  discoveredAt: string;
  category: string | null;
  score: number | null;
  selected: boolean;
  reason: string | null;
  attribution: { name: string; url: string };
}

export interface PublishOptions {
  now?: Date;
  /** Historical import: the item was already public, so it is released at its discovery time. */
  releasedAt?: Date | null;
}

export interface PublishResult {
  articleId: string;
  changed: boolean;
  selected: boolean;
  visibility: string;
  ledger: "upsert" | "remove" | null;
  /** Something that was public is now shown less (withdrawn, out of the pool or selection, full text revoked). */
  reduced: boolean;
}

function pickString(override: unknown, fallback: string | null): string | null {
  return typeof override === "string" && override.trim() !== "" ? override.trim() : fallback;
}

function round1(n: number | null): number | null {
  return n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10;
}

export function v1Payload(p: {
  articleId: string; title: string; originalTitle: string | null; summary: string | null; sourceName: string; url: string;
  publishedAt: Date | null; discoveredAt: Date; category: string | null; score: number | null; selected: boolean; reason: string | null;
}): V1ItemPayload {
  const aihot = itemUrl(p.articleId);
  return {
    id: p.articleId,
    title: p.title,
    originalTitle: p.originalTitle,
    summary: p.summary,
    source: { name: p.sourceName },
    links: { aihot, original: p.url },
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    discoveredAt: p.discoveredAt.toISOString(),
    category: toPublicApiCategory(p.category),
    score: p.score === null ? null : Math.round(p.score),
    selected: p.selected,
    reason: p.selected ? p.reason : null,
    attribution: { name: SITE.name, url: aihot },
  };
}

/** Allocates the next ledger sequence under a transaction lock so sequence order equals commit order. */
async function appendLedger(tx: Tx, articleId: string, op: "upsert" | "remove", payload: V1ItemPayload | null, now: Date): Promise<number> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('selected_ledger'))`;
  const { next } = one(await tx<{ next: number }[]>`SELECT coalesce(max(seq), 0) + 1 AS next FROM selected_ledger`);
  await tx`INSERT INTO selected_ledger (seq, article_id, op, changed_at, visible_at, payload)
           VALUES (${next}, ${articleId}, ${op}, ${now}, ${now}, ${payload ? tx.json(payload as never) : null})`;
  return next;
}

/**
 * The selected set of v1, RSS and the sync ledger holds one seat per fact: among the fact's selected
 * public reports, the representative (first-party, full text, higher score, earliest) takes it, and a
 * change of representative removes the old one and adds the new one.
 * The website folds the same reports into reading groups instead. An article outside any fact keeps
 * its own seat. Returns the ledger change of `self` when this settling made one.
 */
async function settleSeats(tx: Tx, factId: number | null, self: string | null, now: Date): Promise<"upsert" | "remove" | null> {
  if (factId === null) {
    if (self) await tx`UPDATE publications SET seat = true WHERE article_id = ${self} AND NOT seat`;
    return null;
  }
  const members = await tx<Array<Pick<PublicationRow, "article_id" | "score"> & RepresentativeIdentity & { body_mode: "full" | "summary"; timeline_at: Date; seat: boolean; holds: boolean }>>`
    SELECT p.article_id, p.body_mode, p.score, p.timeline_at, p.seat, ${REPRESENTATIVE_COLUMNS},
      (p.selected AND p.visibility = 'public' AND ${ownFactEvidenceCondition()}) AS holds
    FROM publications p JOIN sources s ON s.id = p.source_id JOIN facts f ON f.id = p.fact_id WHERE p.fact_id = ${factId}`;
  const candidates = members.filter((m) => m.holds).map((m) => ({ ...m, score: m.score === null ? null : Number(m.score) }));
  const rep = candidates.length ? pickRepresentative(candidates) : null;
  let own: "upsert" | "remove" | null = null;
  for (const m of members) {
    const seat = !m.holds || m.article_id === rep?.article_id;
    if (seat === m.seat) continue;
    await tx`UPDATE publications SET seat = ${seat} WHERE article_id = ${m.article_id}`;
    const change = await syncLedger(tx, m.article_id, now);
    if (m.article_id === self) own = change;
  }
  return own;
}

/** Brings one article's place in the selected sync ledger in line with its publication. */
async function syncLedger(tx: Tx, articleId: string, now: Date): Promise<"upsert" | "remove" | null> {
  const [p] = await tx<Array<{ selected: boolean; visibility: string; seat: boolean; title: string; original_title: string | null; summary: string | null;
    url: string; published_at: Date | null; discovered_at: Date; category: string | null; score: string | number | null; reason: string | null;
    source_name: string }>>`
    SELECT p.selected, p.visibility, p.seat, p.title, p.original_title, p.summary, p.url, p.published_at, p.discovered_at, p.category,
           p.score, p.reason, s.name AS source_name
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id = ${articleId}`;
  if (!p) return null;
  const [state] = await tx<{ in_set: boolean; payload_hash: string | null }[]>`SELECT in_set, payload_hash FROM selected_state WHERE article_id = ${articleId}`;
  if (p.selected && p.visibility === "public" && p.seat) {
    const payload = v1Payload({
      articleId, title: p.title, originalTitle: p.original_title, summary: p.summary, sourceName: p.source_name, url: p.url,
      publishedAt: p.published_at, discoveredAt: p.discovered_at, category: p.category, score: p.score === null ? null : Number(p.score), selected: true, reason: p.reason,
    });
    const payloadHash = sha256(stableJson(payload));
    if (state?.in_set && state.payload_hash === payloadHash) return null;
    const seq = await appendLedger(tx, articleId, "upsert", payload, now);
    await tx`INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq) VALUES (${articleId}, true, ${payloadHash}, ${seq})
             ON CONFLICT (article_id) DO UPDATE SET in_set = true, payload_hash = EXCLUDED.payload_hash, last_seq = EXCLUDED.last_seq`;
    return "upsert";
  }
  if (!state?.in_set) return null;
  const seq = await appendLedger(tx, articleId, "remove", null, now);
  await tx`UPDATE selected_state SET in_set = false, payload_hash = NULL, last_seq = ${seq} WHERE article_id = ${articleId}`;
  return "remove";
}

export async function publishArticle(articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  return sql.begin((tx) => publishArticleTx(tx, articleId, options));
}

export async function publishArticleTx(tx: Tx, articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  const [article] = await tx<ArticleRow[]>`
    SELECT id, source_id, url, title, language, published_at, discovered_at, timeline_at, backfill, body_status,
           body_text, x_post, grouped_at, grouping_status, selection_adds_value
    FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!article) return null;
  // Explicit imports carry an already-public editorial decision, not a new pending judgement.
  if (options.releasedAt && article.grouping_status === "pending") {
    await tx`UPDATE articles SET grouping_status = 'complete', grouped_at = coalesce(grouped_at, ${options.releasedAt}) WHERE id = ${articleId}`;
    article.grouping_status = "complete";
  }
  const [source] = await tx<SourceFacts[]>`
    SELECT id, name, kind, tier, participation_mode, first_party, site_fulltext, syndicate_fulltext FROM sources WHERE id = ${article.source_id}`;
  if (!source) return null;
  const [analysis] = await tx<AnalysisRow[]>`
    SELECT id, relevance, category, tags, subjects, title_zh, summary_zh, reason_zh, score, selected
    FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  const [override] = await tx<OverrideRow[]>`SELECT fields, visibility FROM editorial_overrides WHERE article_id = ${articleId}`;
  const [membership] = await tx<{ fact_id: number; story_id: number | null }[]>`
    SELECT fa.fact_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    LEFT JOIN stories s ON s.id = f.story_id
    WHERE fa.article_id = ${articleId} AND NOT ${latestCompositeCondition(sql`${articleId}`)} AND fa.role IN ('primary', 'report') AND (s.id IS NULL OR s.merged_into IS NULL)
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  const [previous] = await tx<PublicationRow[]>`SELECT * FROM publications WHERE article_id = ${articleId}`;
  // The seats of this article's facts (before and after) are settled in this transaction: take the
  // facts' locks first, in a fixed order, so two reports of one fact never settle it at once.
  const seatFacts = [...new Set([previous?.fact_id, membership?.fact_id].filter((x): x is number => typeof x === "number"))].sort((a, b) => a - b);
  for (const fact of seatFacts) await tx`SELECT pg_advisory_xact_lock(hashtext(${`seat:${fact}`}))`;
  // Reports wait for in-flight publication transactions before taking their candidate snapshot.
  // Stamp releases after all lock waits, which can cross an edition's cutoff.
  await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
  const now = options.now ?? new Date();

  const f = override?.fields ?? {};
  const isChineseTitle = article.language === "zh" || /[一-鿿]/.test(article.title);
  // An X post carries its Chinese in the summary and translation; without a Chinese title its own
  // text is the title, where an article would still be a half-finished card.
  const zhTitle = analysis?.title_zh?.trim() ? analysis.title_zh : null;
  const title = pickString(f.title, zhTitle ?? (isChineseTitle || article.x_post ? collapseWhitespace(article.title) : null));
  const summary = pickString(f.summary, analysis?.summary_zh ?? null);
  const category = pickString(f.category, analysis?.category ?? null);
  const tags = Array.isArray(f.tags) ? (f.tags as string[]) : [...new Set([...(analysis?.tags ?? []), ...(analysis?.subjects ?? []).map((s) => `entity:${s}`)])];
  const score = typeof f.score === "number" ? f.score : analysis?.score ?? null;
  const relevance = typeof f.relevance === "string" ? (f.relevance as string) : analysis?.relevance ?? null;
  const judgedSelected = typeof f.selected === "boolean" ? (f.selected as boolean) : analysis?.selected ?? null;
  // Material from an isolated source reaches no public surface at all: not even a detail page.
  const visibility = source.participation_mode === "isolated" ? "withdrawn" : (override?.visibility ?? "public");

  const eligible = isPoolEligible({ participationMode: source.participation_mode, relevance, title, summary });
  const selectionCandidate = isSelectable(eligible, judgedSelected, source.tier);
  // Scoring nominates a report; a completed identity/value decision admits it to selection.
  // A historical import already has its public decision. Preserve that confirmed state on rebuild.
  const selected = selectionCandidate && article.grouping_status === "complete"
    && (f.selected === true || article.selection_adds_value !== false);
  const reason = selected ? pickString(f.reason, analysis?.reason_zh ?? null) : null;
  const hasXPost = !!article.x_post;
  const channel = channelOf(source.kind, hasXPost);
  const bodyMode = bodyModeOf(source, article.body_status, !!article.body_text && article.body_text.length > 0);
  const syndicate = mayRedistribute(source, bodyMode);
  const originalTitle = isChineseTitle && title === collapseWhitespace(article.title) ? null : collapseWhitespace(article.title);

  // Waiting candidates are readable in the pool, with no selected seat, sync entry or push.
  // Completion stamps the actual release after lock waits, including across report cutoffs.
  const selectedReadyAt = previous?.selected_ready_at ?? (selectionCandidate ? options.releasedAt ?? now : null);
  const visibleAfter = selected ? (previous?.selected && previous.visible_after ? previous.visible_after : options.releasedAt ?? now) : null;

  const indexable = isIndexable({
    visibility, hasSummary: !!summary, selected, seoIndexedAt: previous?.seo_indexed_at ?? null, seoExcludedAt: previous?.seo_excluded_at ?? null,
  });
  const searchText = collapseWhitespace(
    [title, originalTitle, summary, publicSourceName(source.name), ...displayTags(tags), ...(analysis?.subjects ?? [])].filter(Boolean).join(" "),
  ).toLowerCase();

  // A selected item sits at its reading group's anchor: the earliest public pool member of its fact.
  let sortAt: Date = article.timeline_at;
  if (selected && membership?.fact_id) {
    const [anchor] = await tx<{ t: Date | null }[]>`
      SELECT min(timeline_at) AS t FROM publications
      WHERE fact_id = ${membership.fact_id} AND eligible AND visibility = 'public' AND article_id <> ${articleId}`;
    if (anchor?.t && anchor.t < sortAt) sortAt = anchor.t;
  }

  const next = {
    source_id: source.id, first_party: source.tier === "T1",
    visibility, eligible, selected, selection_candidate: selectionCandidate, title: title ?? collapseWhitespace(article.title), original_title: originalTitle, summary, reason,
    category, tags, score: round1(score), body_mode: bodyMode, story_id: membership?.story_id ?? null, fact_id: membership?.fact_id ?? null,
    indexable,
  };
  const changed =
    !previous ||
    stableJson({ ...next, tags: [...next.tags].sort() }) !==
      stableJson({
        source_id: previous.source_id, first_party: previous.first_party,
        visibility: previous.visibility, eligible: previous.eligible, selected: previous.selected, selection_candidate: previous.selection_candidate, title: previous.title,
        original_title: previous.original_title, summary: previous.summary, reason: previous.reason, category: previous.category,
        tags: [...previous.tags].sort(), score: previous.score === null ? null : Number(previous.score), body_mode: previous.body_mode,
        story_id: previous.story_id, fact_id: previous.fact_id, indexable: previous.indexable,
      });
  const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;

  await tx`
    INSERT INTO publications (article_id, analysis_id, revision, visibility, eligible, selected, selection_candidate, title, original_title, summary,
      reason, category, tags, score, source_id, channel, first_party, url, published_at, discovered_at, timeline_at, backfill,
      selected_ready_at, visible_after, body_mode, syndicate, indexable, story_id, fact_id, search_text, sort_at, updated_at)
    VALUES (${articleId}, ${analysis?.id ?? null}, ${revision}, ${visibility}, ${eligible}, ${selected}, ${selectionCandidate}, ${next.title},
      ${originalTitle}, ${summary}, ${reason}, ${category}, ${tags}, ${next.score}, ${source.id}, ${channel}, ${source.tier === "T1"},
      ${article.url}, ${article.published_at}, ${article.discovered_at}, ${article.timeline_at}, ${article.backfill},
      ${selectedReadyAt}, ${visibleAfter}, ${bodyMode}, ${syndicate}, ${indexable}, ${next.story_id}, ${next.fact_id}, ${searchText}, ${sortAt}, now())
    ON CONFLICT (article_id) DO UPDATE SET
      analysis_id = EXCLUDED.analysis_id, revision = EXCLUDED.revision, visibility = EXCLUDED.visibility,
      eligible = EXCLUDED.eligible, selected = EXCLUDED.selected, selection_candidate = EXCLUDED.selection_candidate, title = EXCLUDED.title, original_title = EXCLUDED.original_title,
      summary = EXCLUDED.summary, reason = EXCLUDED.reason, category = EXCLUDED.category, tags = EXCLUDED.tags,
      score = EXCLUDED.score, source_id = EXCLUDED.source_id, channel = EXCLUDED.channel, first_party = EXCLUDED.first_party,
      url = EXCLUDED.url, published_at = EXCLUDED.published_at, discovered_at = EXCLUDED.discovered_at,
      timeline_at = EXCLUDED.timeline_at, backfill = EXCLUDED.backfill, selected_ready_at = EXCLUDED.selected_ready_at,
      visible_after = EXCLUDED.visible_after, body_mode = EXCLUDED.body_mode, syndicate = EXCLUDED.syndicate,
      indexable = EXCLUDED.indexable, story_id = EXCLUDED.story_id, fact_id = EXCLUDED.fact_id,
      search_text = EXCLUDED.search_text, sort_at = EXCLUDED.sort_at, updated_at = now()
    WHERE (publications.analysis_id, publications.revision, publications.visibility, publications.eligible,
        publications.selected, publications.selection_candidate, publications.title, publications.original_title, publications.summary,
        publications.reason, publications.category, publications.tags, publications.score,
        publications.source_id, publications.channel, publications.first_party, publications.url,
        publications.published_at, publications.discovered_at, publications.timeline_at, publications.backfill,
        publications.selected_ready_at, publications.visible_after, publications.body_mode, publications.syndicate,
        publications.indexable, publications.story_id, publications.fact_id, publications.search_text,
        publications.sort_at)
      IS DISTINCT FROM (EXCLUDED.analysis_id, EXCLUDED.revision, EXCLUDED.visibility, EXCLUDED.eligible,
        EXCLUDED.selected, EXCLUDED.selection_candidate, EXCLUDED.title, EXCLUDED.original_title, EXCLUDED.summary,
        EXCLUDED.reason, EXCLUDED.category, EXCLUDED.tags, EXCLUDED.score,
        EXCLUDED.source_id, EXCLUDED.channel, EXCLUDED.first_party, EXCLUDED.url,
        EXCLUDED.published_at, EXCLUDED.discovered_at, EXCLUDED.timeline_at, EXCLUDED.backfill,
        EXCLUDED.selected_ready_at, EXCLUDED.visible_after, EXCLUDED.body_mode, EXCLUDED.syndicate,
        EXCLUDED.indexable, EXCLUDED.story_id, EXCLUDED.fact_id, EXCLUDED.search_text,
        EXCLUDED.sort_at)`;

  // The pool search row follows eligibility; its body part only covers full text the site may show.
  if (eligible) {
    const body = bodyMode === "full" ? (article.body_text ?? "").slice(0, 12000).toLowerCase() : "";
    await tx`INSERT INTO pool_search (article_id, direct, body) VALUES (${articleId}, ${searchText}, ${body})
             ON CONFLICT (article_id) DO UPDATE SET direct = EXCLUDED.direct, body = EXCLUDED.body
             WHERE pool_search.direct IS DISTINCT FROM EXCLUDED.direct OR pool_search.body IS DISTINCT FROM EXCLUDED.body`;
  } else {
    await tx`DELETE FROM pool_search WHERE article_id = ${articleId}`;
  }

  // Content-group push: once, for an item that arrives live and becomes selected (never for imports,
  // backfill or stale-on-discovery material).
  if (selected && !previous?.selected && !options.releasedAt && !article.backfill && visibility === "public") {
    await enqueue(QUEUES.notifySelected, { articleId }, { singletonKey: `selected:${articleId}`, startAfter: new Date(now.getTime() + 5_000) }, tx);
    // Prepare its images alongside the newly confirmed selection.
    await enqueue(QUEUES.prepareMedia, { articleId }, { singletonKey: `media:${articleId}` }, tx);
  }

  // Seats of the fact this article reports (and of the one it left), then its place in the sync ledger.
  let ledger = await settleSeats(tx, membership?.fact_id ?? null, articleId, now);
  if (previous?.fact_id && previous.fact_id !== membership?.fact_id) await settleSeats(tx, previous.fact_id, null, now);
  ledger = (await syncLedger(tx, articleId, now)) ?? ledger;

  const wasPublic = !!previous && previous.visibility !== "withdrawn" && previous.eligible;
  const reduced =
    wasPublic &&
    (visibility === "withdrawn" || !eligible ||
      (previous!.visibility === "public" && visibility !== "public") ||
      (previous!.selected && !selected) ||
      (previous!.body_mode === "full" && bodyMode !== "full"));
  return { articleId, changed, selected, visibility, ledger, reduced };
}

/**
 * An editor's search-index decision: marking indexes the page; unmarking excludes it, so a
 * selected page is not indexed again automatically. The decision and projection commit with the audit.
 */
export async function setSeoDecision(tx: Tx, articleId: string, indexed: boolean): Promise<PublishResult | null> {
  await tx`UPDATE publications SET seo_indexed_at = CASE WHEN ${indexed} THEN coalesce(seo_indexed_at, now()) ELSE NULL END,
              seo_excluded_at = CASE WHEN ${indexed} THEN NULL ELSE now() END WHERE article_id = ${articleId}`;
  return publishArticleTx(tx, articleId);
}

/**
 * Re-derives every published article of one source (after its participation, licences, tier or name
 * changed) without calling models. Runs in the worker; progress goes to the callback.
 */
export async function republishSource(sourceId: string, onProgress?: (done: number, total: number) => Promise<void>): Promise<{ total: number; changed: number; reduced: number }> {
  const { total } = one(await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM publications WHERE source_id = ${sourceId}`);
  let after = "";
  let done = 0;
  let changed = 0;
  let reduced = 0;
  for (;;) {
    const batch = await sql<{ article_id: string }[]>`
      SELECT article_id FROM publications WHERE source_id = ${sourceId} AND article_id > ${after} ORDER BY article_id LIMIT 500`;
    if (batch.length === 0) break;
    for (const { article_id } of batch) {
      // Stopping mid-way is safe: the job is retried after the restart and re-derives from the start.
      if (shutdownSignal.signal.aborted) throw new Error("worker is stopping; republish resumes after restart");
      const r = await publishArticle(article_id);
      if (r?.changed) changed += 1;
      if (r?.reduced) reduced += 1;
    }
    done += batch.length;
    after = batch[batch.length - 1]!.article_id;
    await onProgress?.(done, total);
  }
  return { total, changed, reduced };
}
