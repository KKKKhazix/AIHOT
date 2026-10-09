// Failure cases: an independent source loses its card to an official report; its early arrival moves
// the ordinary reading group; enabling the policy rejudges history or changes event membership;
// another channel/name match inherits it; an unselected/pending/low-value item bypasses admission;
// ordinary duplicates point to the independent item instead of their representative; outlets or
// cursors lose one of the cards; withdrawal leaves a stale selected/sync entry.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { installModules } from '@aihot/backend/modules';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle, republishSource } from '@aihot/backend/publication/publish';
import { loadTimeline } from '@aihot/backend/publication/timeline';
import { setVisibility } from '@aihot/backend/admin/content';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { buildApp } from '../apps/api/src/app.ts';

const T = tag();
const own = `independent-${T}`, officialSource = `official-${T}`, xSource = `other-channel-${T}`;
const now = new Date(Date.now() - 1000);
const app = await buildApp();
after(async () => { await app.close(); installModules([]); await stopBoss(); await closeDb(); });
const get = async (url: string) => { const r = await app.inject({ method: 'GET', url }); assert.equal(r.statusCode, 200, url); return r; };

test('independent selected sources retain identity and their own cards across publication outlets', async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES
    (${own},'Shared author','mp_account','T1_5','editorial','2100-01-01'),
    (${officialSource},'Official','rss','T1','editorial','2100-01-01'),
    (${xSource},'Shared author','x_search','T1_5','editorial','2100-01-01')`;
  const [story] = await sql<{id:number}[]>`INSERT INTO stories(public_id,title) VALUES (${randomUUID()},${T}) RETURNING id`;
  const [fact] = await sql<{id:number}[]>`INSERT INTO facts(public_id,story_id,title) VALUES (${T},${story!.id},${T}) RETURNING id`;
  let n = 0;
  const add = async (source: string, ago: number, options: { selected?: boolean; pending?: boolean; adds?: boolean } = {}) => {
    const at = new Date(+now - ago);
    const {articleId:id} = await upsertMaterial({ sourceId:source,url:`https://example.org/${T}/${++n}`,title:`${T} ${n}`,
      bodyText:'Original article',bodyStatus:'ok',via:'fetch',publishedAt:at,discoveredAt:at });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected,tags,subjects)
      VALUES (${id},1,'rule','pass','industry',${`${T} title ${n}`},'summary','reason',81,${options.selected ?? true},${[T]},${['openai']})`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
    await sql`UPDATE articles SET grouping_status=${options.pending ? 'pending' : 'complete'},selection_adds_value=${options.adds ?? true} WHERE id=${id}`;
    await publishArticle(id,{now});
    return id;
  };
  const firstOwn = await add(own, 3_600_000);
  const official = await add(officialSource, 1_800_000);
  const other = await add(xSource, 900_000);
  const laterOwn = await add(own, 60_000);
  const rejected = await add(own, 50_000, {selected:false});
  const pending = await add(own, 40_000, {pending:true});
  const lowValue = await add(own, 30_000, {adds:false});
  const before = await sql`SELECT article_id,fact_id,role,manual FROM fact_articles WHERE fact_id=${fact!.id} ORDER BY article_id`;
  const analysisCount = (await sql`SELECT count(*) AS n FROM analyses`)[0]!.n;
  const snapshot = (await get('/api/v1/selected/snapshot?limit=1000')).json();

  installModules([{name:'test-presentation', independentSelectedSources:[own]}]);
  await republishSource(own);
  await publishArticle(official,{now});
  await publishArticle(other,{now});
  const selected = (await get(`/api/v1/items?mode=selected&window=24h&q=${T}&limit=100`)).json().items;
  assert.deepEqual(new Set(selected.map((x: {id:string})=>x.id)),new Set([firstOwn,laterOwn,official]));
  assert.equal((await sql`SELECT count(*) AS n FROM analyses`)[0]!.n,analysisCount,'republication reuses the judgement');
  assert.deepEqual(await sql`SELECT article_id,fact_id,role,manual FROM fact_articles WHERE fact_id=${fact!.id} ORDER BY article_id`,before);
  const filters = {channel:'all' as const,category:null,tag:T,now:new Date()};
  const timeline = await loadTimeline(filters);
  assert.deepEqual(timeline.cards.map(c=>c.item.id),[laterOwn,official,firstOwn]);
  assert.equal(timeline.cards[1]!.anchorAt,new Date(+now-1_800_000).toISOString(),'independent arrival does not date the ordinary reading group');
  for (const id of [firstOwn,laterOwn]) assert.equal(timeline.cards.find(c=>c.item.id===id)!.group,null);
  const paged = []; let cursor: string|null = null;
  do { const page = await loadTimeline({...filters,limit:1,cursor}); paged.push(...page.cards.map(c=>c.item.id)); cursor=page.nextCursor; } while(cursor);
  assert.deepEqual(paged,timeline.cards.map(c=>c.item.id));
  const channel = await loadTimeline({...filters,channel:'x'});
  assert.deepEqual(channel.cards.map(c=>c.item.id),[other],'other channel follows ordinary grouping');
  for (const id of [firstOwn,laterOwn]) {
    const detail = (await get(`/api/site/items/${id}`)).json();
    assert.equal(detail.sameEvent ?? null,null); assert.equal(detail.selected,true); assert.ok(detail.reason);
  }
  assert.equal((await get(`/api/site/items/${other}`)).json().sameEvent.id,official);
  for (const id of [rejected,pending,lowValue]) assert.equal((await get(`/api/site/items/${id}`)).json().selected,false);
  for (const url of ['/feed.xml','/api/v1/agent/latest?limit=30','/api/v1/selected/snapshot?limit=1000','/api/site/topics/openai']) {
    const body=(await get(url)).body;
    for (const id of [firstOwn,laterOwn,official]) assert.ok(body.includes(id),`${url}: ${id}`);
  }
  const changes=(await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}`)).json().changes;
  for (const id of [firstOwn,laterOwn]) assert.ok(changes.some((c: {op:string;item?:{id:string}})=>c.op==='upsert'&&c.item?.id===id));
  await setVisibility(laterOwn,{visibility:'withdrawn',reason:'test withdrawal',version:0},'test');
  const remaining=(await get(`/api/v1/items?mode=selected&q=${T}&limit=100`)).json().items;
  assert.deepEqual(new Set(remaining.map((x:{id:string})=>x.id)),new Set([firstOwn,official]));
  assert.equal((await get(`/api/site/items/${other}`)).json().sameEvent.id,official);
});
