// Merging stories: facts and heat evidence move into the surviving story, and the old
// public id keeps answering as an alias. Editors merge from the admin; grouping merges when two
// stories turn out to be one (consolidate in group.ts). Merging facts: one happening that grew two
// facts becomes one, so its reports share one card (cards.ts).
import { sql, type Tx } from "../db.ts";
import { audit } from "../audit.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { republishTx } from "../publication/publish.ts";

/** The moves of a story merge, in the caller's transaction. Null when missing/already merged, or when grouping would change an editor-confirmed identity. */
async function mergeStoryTx(tx: Tx, fromId: number, intoId: number, actor: string): Promise<true | null> {
  const [from] = await tx<{ public_id: string; merged_into: number | null; origin: string }[]>`SELECT public_id, merged_into, origin FROM stories WHERE id = ${fromId} FOR UPDATE`;
  const [into] = await tx<{ merged_into: number | null; origin: string }[]>`SELECT merged_into, origin FROM stories WHERE id = ${intoId} FOR UPDATE`;
  if (!from || !into || from.merged_into || into.merged_into) return null;
  if (actor === "grouping" && (from.origin === "manual" || into.origin === "manual")) return null;
  await tx`UPDATE facts SET story_id = ${intoId}, updated_at = now() WHERE story_id = ${fromId}`;
  // A report with evidence in both stories keeps one row: (story, article) is unique.
  await tx`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
           SELECT ${intoId}, article_id, participant_key, source_id, kind, observed_at FROM story_signals WHERE story_id = ${fromId}
           ON CONFLICT (story_id, article_id) DO NOTHING`;
  await tx`DELETE FROM story_signals WHERE story_id = ${fromId}`;
  await tx`UPDATE stories SET merged_into = ${intoId}, version = version + 1, updated_at = now() WHERE id = ${fromId}`;
  await tx`UPDATE stories SET version = version + 1, updated_at = now(),
             latest_at = greatest(latest_at, (SELECT latest_at FROM stories WHERE id = ${fromId})),
             first_report_at = least(first_report_at, (SELECT first_report_at FROM stories WHERE id = ${fromId}))
           WHERE id = ${intoId}`;
  await tx`INSERT INTO story_aliases (public_id, story_id) VALUES (${from.public_id}, ${intoId}) ON CONFLICT DO NOTHING`;
  return true;
}

/** Null when missing/already merged, or when grouping would change an editor-confirmed identity. */
export async function mergeStoryInto(fromId: number, intoId: number, reason: string, actor: string): Promise<{ moved: number } | null> {
  if (fromId === intoId) throw new Error("cannot merge a story into itself");
  return sql.begin(async (tx) => {
    // Locks in mergeFactInto's order, facts, then their reports, then the stories: corrections and
    // grouping take an article's row lock before its story's, a single publication before its fact's
    // seat, and each republication below holds its seat until commit. NO KEY UPDATE leaves the key
    // share a new membership takes on its fact free.
    await tx`SELECT 1 FROM facts WHERE story_id IN (${fromId}, ${intoId}) ORDER BY id FOR NO KEY UPDATE`;
    const ids = (await tx<{ article_id: string }[]>`SELECT DISTINCT fa.article_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE f.story_id IN (${fromId}, ${intoId})`).map((r) => r.article_id);
    await tx`SELECT 1 FROM articles WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE`;
    if (!(await mergeStoryTx(tx, fromId, intoId, actor))) return null;
    const articles = await tx<{ article_id: string }[]>`SELECT DISTINCT fa.article_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE f.story_id = ${intoId}`;
    for (const a of articles) await republishTx(tx, a.article_id);
    await enqueue(QUEUES.digest, { storyId: intoId }, { singletonKey: `story:${intoId}` }, tx);
    await audit(actor, "story.merge", `story:${fromId}`, reason, null, { into: intoId }, { db: tx });
    return { moved: articles.length };
  });
}

/**
 * The reports of a fact move into the fact that holds the same news, and the posts attached to it
 * follow; the emptied fact stays behind without reports, as it does after a manual move. One
 * transaction, so a failure leaves no public projection pointing at an emptied fact. Null when either
 * is missing, or when an editor placed a report in the fact: grouping does not change a confirmed identity.
 */
export async function mergeFactInto(fromId: number, intoId: number, reason: string, actor: string): Promise<{ moved: number } | null> {
  if (fromId === intoId) throw new Error("cannot merge a fact into itself");
  return sql.begin(async (tx) => {
    const facts = await tx<{ id: number; story_id: number | null }[]>`SELECT id, story_id FROM facts WHERE id IN (${fromId}, ${intoId}) ORDER BY id FOR UPDATE`;
    const fromStory = facts.find((f) => Number(f.id) === fromId)?.story_id ?? null;
    const intoStory = facts.find((f) => Number(f.id) === intoId)?.story_id ?? null;
    if (facts.length < 2 || !intoStory) return null;
    // Corrections hold the article's row lock: take it before reading who belongs here or who placed them.
    const ids = (await tx<{ article_id: string }[]>`SELECT article_id FROM fact_articles WHERE fact_id = ${fromId}`).map((r) => r.article_id);
    await tx`SELECT 1 FROM articles WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE`;
    const [placed] = await tx`SELECT 1 FROM fact_articles WHERE fact_id = ${fromId} AND manual LIMIT 1`;
    if (placed) return null;
    const [primary] = await tx`SELECT 1 FROM fact_articles WHERE fact_id = ${intoId} AND role = 'primary' LIMIT 1`;
    // A report mentioned by the surviving fact becomes its report; a fact keeps one primary.
    const moved = await tx<{ article_id: string; role: string }[]>`
      WITH gone AS (DELETE FROM fact_articles WHERE fact_id = ${fromId} AND article_id = ANY(${ids}) RETURNING article_id, role, evidence, created_at),
      arrived AS (
        INSERT INTO fact_articles (fact_id, article_id, role, evidence, created_at)
        SELECT ${intoId}, article_id, CASE WHEN role = 'primary' AND ${!!primary} THEN 'report' ELSE role END, evidence, created_at FROM gone
        ON CONFLICT (fact_id, article_id) DO UPDATE SET role = EXCLUDED.role, evidence = coalesce(fact_articles.evidence, EXCLUDED.evidence)
        WHERE fact_articles.role = 'mention' AND EXCLUDED.role <> 'mention')
      SELECT article_id, role FROM gone`;
    // Recall finds an attached post's fact through its latest attaching decision; a post regrouped or placed by an editor since belongs elsewhere.
    const posts = await tx<{ article_id: string }[]>`
      WITH latest AS (
        SELECT DISTINCT ON (d.article_id) d.id, d.fact_id FROM grouping_decisions d
        WHERE d.verdict IN ('signal', 'signal-native')
          AND d.article_id IN (SELECT article_id FROM grouping_decisions WHERE fact_id = ${fromId} AND verdict IN ('signal', 'signal-native'))
          AND NOT EXISTS (SELECT 1 FROM fact_articles m WHERE m.article_id = d.article_id AND m.manual)
        ORDER BY d.article_id, d.id DESC)
      UPDATE grouping_decisions d SET fact_id = ${intoId}, story_id = ${intoStory} FROM latest WHERE d.id = latest.id AND latest.fact_id = ${fromId} RETURNING d.article_id`;
    if (fromStory && fromStory !== intoStory) {
      const evidence = [...moved.filter((m) => m.role !== "mention").map((m) => m.article_id), ...posts.map((p) => p.article_id)];
      // A report with evidence in both stories keeps one row: (story, article) is unique.
      await tx`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
               SELECT ${intoStory}, article_id, participant_key, source_id, kind, observed_at FROM story_signals WHERE story_id = ${fromStory} AND article_id = ANY(${evidence})
               ON CONFLICT (story_id, article_id) DO NOTHING`;
      await tx`DELETE FROM story_signals WHERE story_id = ${fromStory} AND article_id = ANY(${evidence})`;
      await tx`UPDATE stories SET updated_at = now(),
                 latest_at = greatest(latest_at, (SELECT max(observed_at) FROM story_signals WHERE story_id = ${intoStory})),
                 first_report_at = least(first_report_at, (SELECT min(observed_at) FROM story_signals WHERE story_id = ${intoStory}))
               WHERE id = ${intoStory}`;
      const [left] = await tx`SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id WHERE f.story_id = ${fromStory} AND fa.role IN ('primary', 'report') LIMIT 1`;
      if (left) await enqueue(QUEUES.digest, { storyId: fromStory }, { singletonKey: `story:${fromStory}` }, tx);
      else if (await mergeStoryTx(tx, fromStory, intoStory, actor)) {
        await audit(actor, "story.merge", `story:${fromStory}`, `报道已全部并入另一个事实，旧地址跳到报道所在事件（事实 ${fromId}）`, null, { into: intoStory }, { db: tx });
      }
    }
    for (const { article_id } of moved) await republishTx(tx, article_id);
    await enqueue(QUEUES.digest, { storyId: intoStory }, { singletonKey: `story:${intoStory}` }, tx);
    await audit(actor, "fact.merge", `fact:${fromId}`, reason, null, { into: intoId, moved: moved.length }, { db: tx });
    return { moved: moved.length };
  });
}
