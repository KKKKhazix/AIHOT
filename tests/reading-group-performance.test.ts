import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { loadTimeline } from '@aihot/backend/publication/timeline';
import { loadStoryFollowups } from '@aihot/backend/publication/followups';

const key = `group${tag()}`;
const storyPublicId = randomUUID();
const now = new Date();
const [source] = await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
  VALUES (${key}, 'Group fixture', 'rss', 'T2', 'editorial', '2100-01-01') RETURNING id`;
const [officialSource] = await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
  VALUES (${key+'-official'}, 'Official fixture', 'rss', 'T1', 'editorial', '2100-01-01') RETURNING id`;
const [story] = await sql`INSERT INTO stories (public_id,title) VALUES (${storyPublicId},'Two developments') RETURNING id`;
const facts = [];
for(let f=0;f<2;f++) {
  const [fact] = await sql`INSERT INTO facts (public_id,story_id,title) VALUES (${key+'-fact-'+f},${story!.id},${'Development '+f}) RETURNING id`;
  facts.push(fact!.id);
  for(let n=0;n<6;n++) {
    const id = `${key}-${f}-${n}`;
    const at = new Date(+now - (f===0 ? 10*86400000 : 3600000) + n*1000);
    await sql`INSERT INTO articles (id,source_id,identity_key,url,title,timeline_at,discovered_at)
      VALUES (${id},${n===2?officialSource!.id:source!.id},${id},${'https://example.org/'+id},${id},${at},${at})`;
    await sql`INSERT INTO publications (article_id,source_id,title,url,channel,timeline_at,discovered_at,sort_at,story_id,fact_id,
      selected,eligible,visible_after,tags,first_party,body_mode,score)
      VALUES (${id},${n===2?officialSource!.id:source!.id},${id},${'https://example.org/'+id},'news',${at},${at},${at},${story!.id},${fact!.id},
      true,true,${at},${[key]},${n===2},'full',${90-n})`;
    await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
  }
}
after(closeDb);

// Failure cases: an old launch lifted by a new evaluation; two news facts hidden in one story card;
// late duplicate reports moving a fact; a representative leaking another fact's sources;
// a withdrawn representative returned; pagination splitting a fact across pages.
test('selected news keeps each fact at its first appearance under its representative',async()=>{
  const timeline = await loadTimeline({channel:'all',category:null,tag:key,now});
  assert.deepEqual(timeline.cards.map(c=>c.item.id),[`${key}-1-2`,`${key}-0-2`]);
  assert.deepEqual(timeline.cards.map(c=>c.anchorAt),[new Date(+now-3600000).toISOString(),new Date(+now-10*86400000).toISOString()]);
  assert.deepEqual(timeline.cards.map(c=>c.group!.reportCount),[6,6]);
  assert.deepEqual(timeline.cards.map(c=>c.group!.additionalSourceCount),[1,1]);
  assert.ok(timeline.cards.every(c=>!('latestDevelopment' in c.group!)&&!('developmentCount' in c.group!)), 'news cards carry no event progress');
  const firstNews=await loadTimeline({channel:'all',category:null,tag:key,now,limit:1});
  const secondNews=await loadTimeline({channel:'all',category:null,tag:key,now,limit:1,cursor:firstNews.nextCursor});
  assert.deepEqual([...firstNews.cards,...secondNews.cards].map(c=>c.item.id),timeline.cards.map(c=>c.item.id));
  const followups=await loadStoryFollowups(storyPublicId,now);
  assert.deepEqual(followups!.items.map(i=>i.representative.id),[`${key}-1-2`,`${key}-0-2`],'each fact by its representative, the latest first');
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${key+'-1-2'}`;
  assert.deepEqual((await loadStoryFollowups(storyPublicId,now))!.items.map(i=>i.representative.id),[`${key}-1-0`,`${key}-0-2`],'a withdrawn representative gives way');
});
