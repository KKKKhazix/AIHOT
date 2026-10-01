// Manual grouping corrections, made from the admin or by an operations script: take a
// report out of its fact, put it into the fact an editor names, merge two stories, or ask for a regroup. Each change is
// written under the article's row lock, which automatic grouping takes too before it writes, and is
// never undone by automatic grouping, retries or later revisions (only an explicit regroup).
import { invalidateStoryInputs, lockStoryMembership } from "./derived-content.ts";
import { audit, Conflict } from "../audit.ts";
import { sql, type Db } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { publishArticle } from "../publication/publish.ts";
import { mergeStoryInto } from "./merge.ts";

/**
 * Takes an article out of its fact; it is shown on its own again and stays that way (automatic
 * grouping, retries and later revisions do not re-attach it; an explicit regroup does). Its heat
 * evidence leaves the old story, whose digest is rewritten.
 */
export async function detachFromFact(id: string, reason: string, actor: string) {
  const { facts, stories } = await sql.begin(async (tx) => {
    // The grouping job writes under the same lock and reads this decision again before it does.
    await tx`SELECT 1 FROM articles WHERE id = ${id} FOR UPDATE`;
    await lockStoryMembership(tx);
    const removed = await tx<{ fact_id: number }[]>`DELETE FROM fact_articles WHERE article_id = ${id} RETURNING fact_id`;
    const factIds = removed.map((r) => r.fact_id);
    const storyRows = factIds.length ? await tx<{ story_id: number }[]>`SELECT DISTINCT story_id FROM facts WHERE id = ANY(${factIds}) AND story_id IS NOT NULL` : [];
    const signals = await tx<{ story_id: number }[]>`DELETE FROM story_signals WHERE article_id = ${id} RETURNING story_id`;
    const storyIds = [...new Set([...storyRows, ...signals].map((r) => r.story_id))];
    await tx`INSERT INTO grouping_overrides (article_id, reason, actor) VALUES (${id}, ${reason}, ${actor})
             ON CONFLICT (article_id) DO UPDATE SET reason = EXCLUDED.reason, actor = EXCLUDED.actor, created_at = now()`;
    await tx`UPDATE articles SET grouped_at = now() WHERE id = ${id}`;
    await invalidateStoryInputs(tx, [], new Date(), factIds);
    return { facts: factIds, stories: storyIds };
  });
  await publishArticle(id);
  // The fact's other reports may take a new reading-group anchor.
  if (facts.length) {
    const others = await sql<{ article_id: string }[]>`SELECT DISTINCT article_id FROM fact_articles WHERE fact_id = ANY(${facts})`;
    for (const o of others) await publishArticle(o.article_id);
  }
  await audit(actor, "content.detach", `content:${id}`, reason, { facts, stories }, null);
  return { detached: facts.length };
}

/** Merges one story into another: facts move, the old public id keeps working as an alias. */
export async function mergeStories(fromId: number, intoId: number, reason: string, actor: string) {
  if (fromId === intoId) throw new Error("cannot merge a story into itself");
  const done = await mergeStoryInto(fromId, intoId, reason, actor);
  if (done) return done;
  const found = await sql<{ id: number }[]>`SELECT id FROM stories WHERE id IN (${fromId}, ${intoId})`;
  if (found.length < 2) throw new Error("story not found");
  throw new Conflict("两个事件都必须是未合并的事件");
}

/**
 * An explicit regroup: it replaces an earlier "keep standalone" decision, and the job drops the
 * automatic membership and decides again (manual memberships still win). The same request id queues
 * one job.
 */
export async function requestRegroup(articleId: string, requestId: string, db: Db = sql): Promise<string | null> {
  await db`DELETE FROM grouping_overrides WHERE article_id = ${articleId}`;
  return enqueue(QUEUES.group, { articleId, force: true }, { singletonKey: `manual:group:${articleId}:${requestId}` }, db);
}
