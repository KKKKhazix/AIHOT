import type { Db } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { editorialPolicy } from "../modules.ts";

/**
 * Reconciles stored fact/story titles, conditions and raw evidence quotes after an article's
 * analysis, suppression state, visibility or manual override changes.
 */
export async function syncArticleEventCopyTx(tx: Db, articleId: string): Promise<void> {
  const sanitizer = editorialPolicy().sanitizeEventCopy;
  if (!sanitizer) return;
  const [article] = await tx<{ id: string; revision: number; title: string; participation_mode: string }[]>`
    SELECT a.id, a.revision, a.title, s.participation_mode
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!article) return;
  const [analysis] = await tx<{ input_revision: number; relevance: string | null; title_zh: string | null; summary_zh: string | null; output: Record<string, any> | null }[]>`
    SELECT input_revision, relevance, title_zh, summary_zh, output FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  const [pub] = await tx<{ visibility: string; suppress_original: boolean; title: string }[]>`
    SELECT visibility, suppress_original, title FROM publications WHERE article_id = ${articleId}`;
  const [override] = await tx<{ fields: Record<string, unknown>; visibility: string | null }[]>`
    SELECT fields, visibility FROM editorial_overrides WHERE article_id = ${articleId}`;

  const memberships = await tx<{
    fact_id: number; role: string; evidence: string | null;
    fact_title: string; subject: string | null; action: string | null; object: string | null; conditions: string | null;
    story_id: number | null; story_title: string | null; story_origin: string | null;
  }[]>`
    SELECT fa.fact_id, fa.role, fa.evidence,
           f.title AS fact_title, f.subject, f.action, f.object, f.conditions,
           st.id AS story_id, st.title AS story_title, st.origin AS story_origin
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    LEFT JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
    WHERE fa.article_id = ${articleId}`;
  if (!memberships.length) return;

  const f = override?.fields ?? {};
  const awaitingReview = Boolean(editorialPolicy().reviewAnalysis)
    && article.participation_mode === "editorial"
    && (!analysis || analysis.input_revision < article.revision);
  const suppressOriginal = awaitingReview
    || (typeof f.suppressOriginal === "boolean" ? f.suppressOriginal : analysis ? analysis.output?.suppressOriginal === true : pub?.suppress_original === true)
    || override?.visibility === "summary-only";
  const withdrawn = override?.visibility === "withdrawn"
    || (!override?.visibility && (analysis ? analysis.output?.withdrawn === true : pub?.visibility === "withdrawn"));

  const dirtyStories = new Set<number>();
  if (suppressOriginal || withdrawn) {
    const cleared = await tx`UPDATE fact_articles SET evidence = NULL WHERE article_id = ${articleId} AND evidence IS NOT NULL RETURNING fact_id`;
    if (cleared.length) {
      for (const m of memberships) if (m.story_id !== null) dirtyStories.add(Number(m.story_id));
    }
  }

  const overrideTitle = typeof f.title === "string" && f.title.trim() ? collapseWhitespace(f.title) : null;
  const ownCleanTitle = overrideTitle ?? (!awaitingReview && analysis?.title_zh?.trim() ? collapseWhitespace(analysis.title_zh) : pub && !withdrawn && pub.title.trim() ? collapseWhitespace(pub.title) : null);
  const frame = !awaitingReview ? ((analysis?.output?.fact ?? null) as Record<string, any> | null) : null;
  const frameTitle = typeof frame?.title === "string" ? collapseWhitespace(frame.title) : "";
  const ownFactCandidate = !withdrawn ? (overrideTitle || frameTitle || ownCleanTitle || "") : "";

  const reportContext = [article.title, ownCleanTitle, !awaitingReview && analysis?.summary_zh].filter(Boolean).join("\n");
  const seenFacts = new Set<number>();
  for (const m of memberships) {
    const factId = Number(m.fact_id);
    if (m.role !== "primary" && m.role !== "report") continue;
    if (seenFacts.has(factId)) continue;
    seenFacts.add(factId);

    const peers = await tx<{ title: string; suppress_original: boolean }[]>`
      SELECT p.title, p.suppress_original
      FROM fact_articles fa2 JOIN publications p ON p.article_id = fa2.article_id
      WHERE fa2.fact_id = ${factId} AND fa2.role IN ('primary', 'report') AND fa2.article_id <> ${articleId}
        AND p.visibility = 'public'
      ORDER BY (fa2.role = 'primary') DESC, p.first_party DESC, coalesce(p.score, 0) DESC`;
    const soleActive = !withdrawn && peers.length === 0;
    const fallbackFactTitle = ownFactCandidate || (peers[0]?.title ? collapseWhitespace(peers[0].title) : "");
    const targetFactTitle = soleActive && ownFactCandidate ? ownFactCandidate : m.fact_title;
    const rawConditions = soleActive && !suppressOriginal && Array.isArray(frame?.conditions)
      ? frame.conditions.map((c: { text?: string }) => c.text).filter(Boolean).join("；") || null
      : (suppressOriginal || withdrawn) && peers.every((p) => p.suppress_original)
        ? null
        : m.conditions;
    const cleaned = sanitizer({
      title: targetFactTitle,
      reportContext,
      fallbackTitle: fallbackFactTitle,
      conditions: rawConditions,
      subject: soleActive && frame ? (frame.subject ?? null) : m.subject,
      action: soleActive && frame ? (frame.action ?? null) : m.action,
      object: soleActive && frame ? (frame.object ?? null) : m.object,
    });
    const factEvidenceChanged = cleaned.conditions !== m.conditions
      || cleaned.subject !== m.subject
      || cleaned.action !== m.action
      || cleaned.object !== m.object;
    if (cleaned.title !== m.fact_title || factEvidenceChanged) {
      await tx`
        UPDATE facts
        SET title = ${cleaned.title},
            conditions = ${cleaned.conditions},
            subject = ${cleaned.subject},
            action = ${cleaned.action},
            object = ${cleaned.object},
            updated_at = now()
        WHERE id = ${factId}`;
      if (m.story_id !== null && factEvidenceChanged) dirtyStories.add(Number(m.story_id));
    }
  }

  const seenStories = new Set<number>();
  for (const m of memberships) {
    if (m.story_id === null || m.story_title === null) continue;
    const storyId = Number(m.story_id);
    if (seenStories.has(storyId)) continue;
    seenStories.add(storyId);

    const storyPeers = await tx<{ title: string }[]>`
      SELECT p.title
      FROM facts f JOIN fact_articles fa2 ON fa2.fact_id = f.id JOIN publications p ON p.article_id = fa2.article_id
      WHERE f.story_id = ${storyId} AND fa2.role IN ('primary', 'report') AND fa2.article_id <> ${articleId}
        AND p.visibility = 'public'
      ORDER BY coalesce(p.published_at, p.discovered_at) DESC LIMIT 1`;
    const soleStoryReport = !withdrawn && storyPeers.length === 0 && (m.role === "primary" || m.role === "report");
    const fallbackStoryTitle = (!withdrawn && (ownFactCandidate || ownCleanTitle) ? (ownFactCandidate || ownCleanTitle!) : storyPeers[0]?.title ? collapseWhitespace(storyPeers[0].title) : "") || "";
    const desiredStoryTitle = m.story_origin !== "manual" && soleStoryReport && (ownFactCandidate || ownCleanTitle)
      ? (ownFactCandidate || ownCleanTitle!)
      : m.story_title;
    const cleanedStory = sanitizer({
      title: desiredStoryTitle,
      reportContext,
      fallbackTitle: fallbackStoryTitle,
    });
    if (cleanedStory.title !== m.story_title) {
      await tx`UPDATE stories SET title = ${cleanedStory.title}, updated_at = now() WHERE id = ${storyId}`;
      dirtyStories.add(storyId);
    }
  }

  for (const storyId of dirtyStories) {
    await enqueue(QUEUES.digest, { storyId }, { singletonKey: `story:${storyId}` }, tx);
  }
}
