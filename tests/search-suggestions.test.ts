// Failure cases, written before replacing the search overlay's two full-page reads:
// - suggestions change the topic order/names or hot ranks/links;
// - hidden/regrouped evidence remains a suggestion after warming a ranking;
// - the response carries article bodies, participants, images or topic statistics;
// - a cached answer loses its validator or outlives the hot list's thirty seconds.
import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import type { HotEntry } from "@aihot/backend/events/hot";
import { buildApp } from "../apps/api/src/app.ts";

const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("search carries exactly the existing topic links and five visible hot links, including after a withdrawal", async () => {
  const at = new Date(Date.now() - 60_000);
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES ('suggestions','Suggestions','rss','T1','editorial','2100-01-01')`;
  const entries: HotEntry[] = [];
  for (let i = 1; i <= 6; i++) {
    const title = `Suggestion ${i}`;
    const id = `suggestion-${i}`;
    const [story] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories (public_id,title)
      VALUES (${randomUUID()},${title}) RETURNING id,public_id`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,story_id,title)
      VALUES (${randomUUID()},${story!.id},${title}) RETURNING id`;
    await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES (${id},'suggestions',${id},${'https://example.org/'+id},${title},${at},${at})`;
    await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
    await sql`INSERT INTO publications (article_id,source_id,title,url,timeline_at,discovered_at,sort_at,body_mode,eligible,channel,story_id,fact_id)
      VALUES (${id},'suggestions',${title},${'https://example.org/'+id},${at},${at},${at},'summary',true,'news',${story!.id},${fact!.id})`;
    entries.push({ rank:i, storyId:story!.id, storyPublicId:story!.public_id, title, heat:10, trend:'flat', trendPct:0, badges:[],
      participantCount:0, sourceCount:1, signalCount:0, reportCount:1, sourceNames:['Suggestions'], latestAt:at.toISOString(), firstReportAt:at.toISOString(),
      representativeItemId:id, representativeUrl:'https://example.org/'+id, representativeSource:'Suggestions', participants:[] });
  }
  await sql`INSERT INTO hot_rankings (computed_at,rule_version,entries,published) VALUES (now(),'test',${sql.json(entries as never)},true)`;
  const read = () => app.inject({ method:'GET', url:'/api/site/search/suggestions' });
  const fullTopics = (await app.inject({ method:'GET', url:'/api/site/topics' })).json();
  const first = await read();
  assert.equal(first.statusCode,200);
  const expectedTopics = fullTopics.topics.map((t: {slug:string;name:string;group:string}) => ({slug:t.slug,name:t.name,group:t.group}));
  const expectedHot = entries.slice(0,5).map(e => ({rank:e.rank,title:e.title,to:'/story/'+e.storyPublicId}));
  assert.deepEqual(first.json(),{topics:expectedTopics,hot:expectedHot});
  assert.equal(first.headers['cache-control'],'public, max-age=30, s-maxage=30, must-revalidate');
  assert.ok(first.headers.etag);
  assert.equal((await app.inject({ method:'GET',url:'/api/site/search/suggestions',headers:{'if-none-match':String(first.headers.etag)} })).statusCode,304);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = 'suggestion-1'`;
  const next = await read();
  assert.deepEqual(next.json().hot,entries.slice(1,6).map(e => ({rank:e.rank,title:e.title,to:'/story/'+e.storyPublicId})));
  assert.notEqual(next.headers.etag,first.headers.etag);
});
