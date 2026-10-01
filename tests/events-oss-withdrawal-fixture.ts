// 仅供事件撤回回归使用的虚构资料；所有读写限定于测试库。
import { tag } from "./setup.ts";
import { randomUUID } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import type { HotEntry } from "@aihot/backend/events/hot";

export const fixtureTag = `f02-${tag()}`;
let sequence = 0;
const sources: string[] = [];
const articles: string[] = [];
const stories: number[] = [];
const rankings: number[] = [];
export async function source() {
  const id = `${fixtureTag}-${++sequence}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
    VALUES(${id},${`测试来源${sequence}`},'rss','T1','editorial',true,'2100-01-01')`;
  sources.push(id);
  return id;
}
export async function article(sourceId: string, title: string, opts: { eligible?: boolean; pending?: boolean } = {}) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.test/${fixtureTag}/${++sequence}`, title,
    bodyText: "虚构测试正文", bodyHtml: "<p>虚构测试正文</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 60_000) });
  articles.push(articleId);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES(${articleId},1,'rule',${opts.eligible === false ? 'block' : 'pass'},'ai-models',${title},${title + '摘要'},'测试',90,true)`;
  await publishArticle(articleId, opts.pending ? {} : { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}
export async function story(members: Array<{ id: string; role?: string }>, marker: string, origin: "model" | "manual" | "replay" = "model") {
  const [row] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories(public_id,title,summary,digest,latest,digest_updated_at,first_report_at,latest_at,origin)
    VALUES(${randomUUID()},${marker},${marker + '旧摘要'},${marker + '旧综述'},${marker + '旧进展'},now(),now(),now(),${origin}) RETURNING id,public_id`;
  const [fact] = await sql<{ id: number; public_id: string }[]>`INSERT INTO facts(public_id,story_id,title,subject,action,object,conditions)
    VALUES(${`${fixtureTag}-fact-${++sequence}`},${row!.id},${marker},${marker},${marker},${marker},${marker}) RETURNING id,public_id`;
  stories.push(row!.id);
  for (const m of members) {
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${m.id},${m.role ?? 'report'})`;
    await publishArticle(m.id);
  }
  return { id: row!.id, publicId: row!.public_id, factId: fact!.id, factPublicId: fact!.public_id, marker };
}
export async function pair(name: string, opts: { origin?: "model" | "manual" | "replay"; eligibleB?: boolean } = {}) {
  const marker = `撤回独有主张${fixtureTag}-${name}`;
  const sourceA = await source();
  const sourceB = await source();
  const a = await article(sourceA, marker);
  const b = await article(sourceB, `仍可公开的报道${name}`, { eligible: opts.eligibleB });
  const st = await story([{ id: a, role: "primary" }, { id: b }], marker, opts.origin);
  return { ...st, a, b, sourceA, sourceB };
}
export async function rank(entries: Array<{ id: number; publicId: string; marker: string; a: string; sourceA: string }>) {
  const at = new Date(Date.now() + 365 * 86400000 + ++sequence * 1000);
  const rows: HotEntry[] = [];
  for (const [i, e] of entries.entries()) {
    const [a] = await sql`SELECT url FROM articles WHERE id=${e.a}`;
    rows.push({ rank: i + 1, storyId: e.id, storyPublicId: e.publicId, title: e.marker, heat: 10, trend: "flat", trendPct: 0,
      badges: [], participantCount: 2, sourceCount: 2, signalCount: 0, reportCount: 2, sourceNames: ["虚构来源"], latestAt: at.toISOString(), firstReportAt: at.toISOString(),
      representativeItemId: e.a, representativeUrl: a!.url, representativeSource: "虚构来源", participants: [] });
  }
  // 故意保留同一持久榜单，使撤回后的即时安全不依赖重算碰巧换了ranking ID。
  const [saved] = await sql<{ id: number }[]>`INSERT INTO hot_rankings(computed_at,rule_version,entries,published) VALUES(${at},'withdrawal-test',${sql.json(rows as never)},true) RETURNING id`;
  rankings.push(saved!.id);
  return saved!.id;
}
export async function sourceVersion(id: string) { return (await sql`SELECT updated_at FROM sources WHERE id=${id}`)[0]!.updated_at.toISOString() as string; }
export function trackStory(id: number) { stories.push(id); }
export async function cleanup() {
  if (rankings.length) await sql`DELETE FROM hot_rankings WHERE id=ANY(${rankings}::bigint[])`;
  if (stories.length) {
    await sql`DELETE FROM story_aliases WHERE story_id=ANY(${stories}::bigint[])`;
    await sql`DELETE FROM facts WHERE story_id=ANY(${stories}::bigint[])`;
    await sql`DELETE FROM stories WHERE id=ANY(${stories}::bigint[])`;
  }
  if (articles.length) {
    await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${articles}::text[])`;
    await sql`DELETE FROM selected_ledger WHERE article_id=ANY(${articles}::text[])`;
    await sql`DELETE FROM articles WHERE id=ANY(${articles}::text[])`;
  }
  if (sources.length) await sql`DELETE FROM sources WHERE id=ANY(${sources}::text[])`;
}
