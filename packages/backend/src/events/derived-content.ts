// 事件派生文字的输入边界：权限变更与安全回退同事务提交，旧文字仅留在私有审计。
import { audit } from "../audit.ts";
import { storyReportCondition, listedCondition, evidenceCondition } from "../publication/scope.ts";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";

export interface DigestReport {
  id: string; title: string; summary: string | null; source_name: string; first_party: boolean; at: Date;
}
export async function digestReports(storyId: number, db: Db = sql, now = new Date()): Promise<DigestReport[]> {
  return db<DigestReport[]>`
    SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.title, p.summary, s.name AS source_name,
      p.first_party, coalesce(p.published_at,p.discovered_at) AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id JOIN publications p ON p.article_id=fa.article_id
    JOIN sources s ON s.id=p.source_id
    WHERE f.story_id=${storyId} AND ${storyReportCondition(now)} AND ${listedCondition(now)} AND ${evidenceCondition()}
    ORDER BY p.article_id`;
}
export function digestInputsHash(reports: DigestReport[]): string {
  return sha256(stableJson([...reports].sort((a, b) => a.id.localeCompare(b.id))
    .map(r => [r.id, r.title, r.summary ?? "", r.source_name, r.first_party, r.at.toISOString()])));
}

// 合并会搬动fact归属；和失效共用短事务锁，避免查询旧归属后漏清存活事件。
export async function lockStoryMembership(db: Db) {
  await db`SELECT pg_advisory_xact_lock(hashtext('story_content_membership'))`;
}

export async function invalidateStoryInputs(db: Db, articleIds: string[], now = new Date(), removedFactIds: number[] = []): Promise<void> {
  if (!articleIds.length && !removedFactIds.length) return;
  await lockStoryMembership(db);
  // 成员已移走时，旧综述仍可能保留其依赖；不能只看当前fact_articles。
  const recorded = await db<{ story_id: number }[]>`
    SELECT story_id FROM (
      SELECT DISTINCT ON (story_id) story_id,article_ids FROM story_digests ORDER BY story_id,version DESC
    ) d WHERE article_ids && ${articleIds}::text[]`;
  const recordedIds = recorded.map(r => r.story_id);
  const facts = await db<Array<{ id: number; story_id: number; title: string; subject: string | null; action: string | null; object: string | null; conditions: string | null; occurred_at: Date | null }>>`
    SELECT DISTINCT f.id,f.story_id,f.title,f.subject,f.action,f.object,f.conditions,f.occurred_at
    FROM facts f WHERE f.story_id IS NOT NULL AND (
      f.id=ANY(${removedFactIds}::bigint[]) OR f.story_id=ANY(${recordedIds}::bigint[]) OR EXISTS (
        SELECT 1 FROM fact_articles fa WHERE fa.fact_id=f.id AND fa.article_id=ANY(${articleIds}::text[])))`;
  const ids = [...new Set([...recordedIds, ...facts.map(f => f.story_id)])].sort((a, b) => a - b);
  if (!ids.length) return;
  const stories = await db<Array<{ id: number; title: string; summary: string | null; digest: string | null; latest: string | null; version: number; origin: string }>>`
    SELECT id,title,summary,digest,latest,version,origin FROM stories
    WHERE id=ANY(${ids}::bigint[]) AND merged_into IS NULL ORDER BY id FOR UPDATE`;
  for (const story of stories) {
    // 公开历史稿也能维持事件；模型输入在digestReports中另加eligible要求。
    const reports = await db<Array<{ fact_id: number; title: string }>>`
      SELECT fa.fact_id,p.title FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
      JOIN publications p ON p.article_id=fa.article_id JOIN sources s ON s.id=p.source_id
      WHERE f.story_id=${story.id} AND ${storyReportCondition(now)} AND ${evidenceCondition()}
      ORDER BY p.first_party DESC,p.selected DESC,coalesce(p.published_at,p.discovered_at),p.article_id`;
    const title = reports[0]?.title ?? "事件更新中";
    const affected = facts.filter(f => f.story_id === story.id);
    await audit("system", "story.inputs_invalidated", `story:${story.id}`, "公开报道权限或文字改变",
      { ...story, facts: affected }, { title, version: story.version + 1 }, { db });
    await db`UPDATE stories SET title=${title},summary=NULL,digest=NULL,latest=NULL,digest_updated_at=NULL,
      version=version+1,updated_at=now() WHERE id=${story.id}`;
    for (const fact of affected) {
      const safeTitle = reports.find(r => r.fact_id === fact.id)?.title ?? "事件更新中";
      await db`UPDATE facts SET title=${safeTitle},subject=NULL,action=NULL,object=NULL,conditions=NULL,occurred_at=NULL,
        version=version+1,updated_at=now() WHERE id=${fact.id}`;
    }
    await enqueue(QUEUES.digest, { storyId: story.id, afterCorrection: true },
      { singletonKey: `story:${story.id}:inputs:${story.version + 1}` }, db);
  }
}
