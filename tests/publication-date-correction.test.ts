// Failure cases: a verified historical date is rejected because imported discovery time is guessed;
// correction changes content revisions, paid decisions or selection; an independent discovery sort is
// overwritten; recent/future or malformed dates and stale identities are accepted; a retry applies a
// second edit; a changed publication decision is overwritten.
// A feed's modification date can also make an old article look live: correcting it must archive
// it and remove automatic event/heat evidence without buying another analysis or sending it again.
// A proven repost timestamp must also be retractable when the publisher cannot supply a date.
// Settled material that never needs grouping (an isolated source's post) or a first import published
// the day it was found (news, not history) must not be refused as unfinished or historical.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { correctPublicationDate, previewPublicationDateCorrection } from '@aihot/backend/admin/content';
import { publishArticle } from '@aihot/backend/publication/publish';
import { getBoss, stopBoss } from '@aihot/backend/jobs/queue';
import { installModules } from '@aihot/backend/modules';
import { pushSelected } from '@aihot/backend/notify/selected';
import { randomUUID } from 'node:crypto';
import { QUEUES } from '@aihot/backend/jobs/queue';

const T=tag();
const source=`date-correction-${T}`;
const isolated=`date-correction-isolated-${T}`;
const old='2020-02-15T00:00:00.000Z';
const corrected='2020-10-29T00:00:00.000Z';
before(async()=>{
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES(${source},'Verified date','rss','T1','editorial',true)`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${isolated},'Isolated','rss','T2','isolated')`;
  installModules([{name:'date-check',on:{articleChanged:async(change,tx)=>{
    await tx`INSERT INTO settings(key,value) VALUES(${`date-hook:${change.id}`},${tx.json(change)})`;
  }}}]);
});
after(async()=>{installModules([]);await stopBoss();await closeDb();});
async function fixture(independent=false){
  const {articleId:id}=await upsertMaterial({sourceId:source,url:`https://example.test/${tag()}`,title:'保留原文',bodyText:'A verified body',bodyStatus:'ok',via:'import',publishedAt:new Date(old),discoveredAt:new Date(old)});
  await sql`UPDATE articles SET backfill=false,backfill_reason=NULL,processing_state='analyzed',grouping_status='complete',grouped_at=now(),
    timeline_at=${new Date(independent?'2020-11-01T00:00:00.000Z':old)} WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected) VALUES(${id},1,'rule','pass','保留标题','保留既有判断',true)`;
  await sql`INSERT INTO editorial_overrides(article_id,fields,version,reason) VALUES(${id},'{"title":"人工标题","selected":true}'::jsonb,3,'Keep editorial judgement')`;
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${id},'Keep manual grouping','test')`;
  await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,response) VALUES(${`date-${id}`},'test','score_article',${`article:${id}`},'completed','{"recorded":true}')`;
  await publishArticle(id);
  return id;
}
async function retained(id:string){
  const [a]=await sql`SELECT revision,content_hash,title,body_text,discovered_at,backfill,backfill_reason,processing_state,processing_attempts,processing_retry_at,
    processing_queued_at,grouping_status,grouped_at,selection_adds_value FROM articles WHERE id=${id}`;
  const [p]=await sql`SELECT to_jsonb(p)-ARRAY['published_at','timeline_at','sort_at','revision','updated_at'] AS decision FROM publications p WHERE article_id=${id}`;
  return {a,publication:p!.decision,analyses:await sql`SELECT * FROM analyses WHERE article_id=${id}`,
    revisions:await sql`SELECT * FROM article_revisions WHERE article_id=${id}`,overrides:await sql`SELECT * FROM editorial_overrides WHERE article_id=${id}`,
    grouping:await sql`SELECT * FROM grouping_overrides WHERE article_id=${id}`,receipts:await sql`SELECT * FROM receipts WHERE subject=${`article:${id}`}`,
    jobs:await sql`SELECT id,name,data FROM pgboss.job ORDER BY id`};
}

test('verified old dates correct publication and its existing date-based sort without rejudging imported history',async()=>{
  const id=await fixture();
  const before=await retained(id);
  const plan=(await previewPublicationDateCorrection(id,corrected))!;
  assert.equal(plan.mode,"history");
  assert.equal(plan.after.publishedAt,corrected);
  assert.equal(plan.after.timelineAt,corrected);
  const result=await correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt:corrected,requestId:`date-${id}`,reason:'Explicit published byline verified'},'test');
  assert.equal(result.status,'corrected');
  assert.deepEqual(await retained(id),before);
  const [a]=await sql`SELECT published_at,published_at_claim,timeline_at FROM articles WHERE id=${id}`;
  for(const date of Object.values(a!))assert.equal(date.toISOString(),corrected);
  const [p]=await sql`SELECT published_at,timeline_at,sort_at FROM publications WHERE article_id=${id}`;
  for(const date of Object.values(p!))assert.equal(date.toISOString(),corrected);
  const [ledger]=await sql`SELECT payload FROM selected_ledger WHERE article_id=${id} ORDER BY seq DESC LIMIT 1`;
  assert.equal(ledger!.payload.publishedAt,corrected);
  assert.equal((await sql`SELECT 1 FROM settings WHERE key=${`date-hook:${id}`}`).length,1);
});

test('an independently recorded discovery sort remains unchanged',async()=>{
  const id=await fixture(true);const plan=(await previewPublicationDateCorrection(id,corrected))!;
  assert.equal(plan.after.timelineAt,'2020-11-01T00:00:00.000Z');
  await correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt:corrected,requestId:`date-${id}`,reason:'Verified original date'},'test');
  const [a]=await sql`SELECT timeline_at FROM articles WHERE id=${id}`;
  assert.equal(a!.timeline_at.toISOString(),'2020-11-01T00:00:00.000Z');
});

test('the request is idempotent and a reused request identity cannot approve a different date',async()=>{
  const id=await fixture();const plan=(await previewPublicationDateCorrection(id,corrected))!;
  const input={version:plan.version,hash:plan.hash,publishedAt:corrected,requestId:`date-${id}`,reason:'Verified original date'};
  const first=await correctPublicationDate(id,input,'test');
  assert.deepEqual(await correctPublicationDate(id,input,'test'),first);
  await assert.rejects(correctPublicationDate(id,{...input,publishedAt:'2020-11-02T00:00:00.000Z'},'test'),/request|请求|日期/);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${id}`} AND action='content.correct-publication-date'`).length,1);
});

test('malformed, recent or future dates and stale material metadata are refused',async()=>{
  const id=await fixture();
  for(const value of ['2020-10-29','2020-02-30T00:00:00.000Z',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+86400000).toISOString()])
    await assert.rejects(previewPublicationDateCorrection(id,value),/ISO|日期|历史|future|recent|historical/);
  const plan=(await previewPublicationDateCorrection(id,corrected))!;
  const input={version:plan.version,hash:plan.hash,publishedAt:corrected,requestId:`stale-${id}`,reason:'Verified original date'};
  await assert.rejects(correctPublicationDate(id,{...input,version:plan.version+1},'test'),/修改|版本|changed/);
  await sql`UPDATE articles SET updated_at=updated_at+interval '1 second' WHERE id=${id}`;
  await assert.rejects(correctPublicationDate(id,input,'test'),/修改|版本|changed/);
  const refreshed=(await previewPublicationDateCorrection(id,corrected))!;
  await sql`UPDATE articles SET url=url||'-changed' WHERE id=${id}`;
  await assert.rejects(correctPublicationDate(id,{...input,hash:refreshed.hash},'test'),/修改|版本|changed/);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${id}`} AND action='content.correct-publication-date'`).length,0);
});

test('a changed publication decision refuses the whole correction',async()=>{
  const id=await fixture();const plan=(await previewPublicationDateCorrection(id,corrected))!;
  const snapshot=async()=>({a:await sql`SELECT * FROM articles WHERE id=${id}`,p:await sql`SELECT * FROM publications WHERE article_id=${id}`,ledger:await sql`SELECT * FROM selected_ledger WHERE article_id=${id}`});
  const before=await snapshot();
  await sql`UPDATE editorial_overrides SET fields='{"selected":false}'::jsonb WHERE article_id=${id}`;
  await assert.rejects(correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt:corrected,requestId:`decision-${id}`,reason:'Verified byline'},'test'),/公开|选稿|decision/);
  assert.deepEqual(await snapshot(),before);
});

async function misdatedFixture(){
  const id=await fixture();
  await sql`DELETE FROM grouping_overrides WHERE article_id=${id}`;
  await sql`UPDATE articles SET published_at=now() - interval '1 minute',published_at_claim=now() - interval '1 minute',discovered_at=now() - interval '1 minute',timeline_at=now() - interval '1 minute' WHERE id=${id}`;
  await publishArticle(id);
  await sql`DELETE FROM settings WHERE key=${`date-hook:${id}`}`;
  return id;
}

test('a recently misdated old article returns to history without new analysis or delivery',async()=>{
  const id=await misdatedFixture();
  const [story]=await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'Old news treated as live') RETURNING id`;
  const [fact]=await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`fact-${id}`},${story!.id},'Old event') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${id},'primary')`;
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${story!.id},${id},${source},${source},'editorial',now() - interval '1 minute')`;
  await publishArticle(id);
  await sql`DELETE FROM settings WHERE key=${`date-hook:${id}`}`;
  const before=await retained(id);
  const plan=(await previewPublicationDateCorrection(id,corrected))!;
  const input={version:plan.version,hash:plan.hash,publishedAt:corrected,requestId:`archive-${id}`,reason:'Feed used modification time; original publication verified'};
  await correctPublicationDate(id,input,'test');
  const after=await retained(id);
  for(const key of ['analyses','revisions','overrides','receipts'] as const)assert.deepEqual(after[key],before[key]);
  assert.equal(after.a!.revision,before.a!.revision);
  const [a]=await sql`SELECT published_at,timeline_at,backfill,backfill_reason FROM articles WHERE id=${id}`;
  assert.equal(a!.published_at.toISOString(),corrected);
  assert.equal(a!.timeline_at.toISOString(),corrected);
  assert.equal(a!.backfill,true);
  assert.equal(a!.backfill_reason,'stale-on-discovery');
  const [p]=await sql`SELECT published_at,sort_at,backfill,selected FROM publications WHERE article_id=${id}`;
  assert.equal(p!.sort_at.toISOString(),corrected);
  assert.equal(p!.backfill,true);
  assert.equal(p!.selected,true,'the existing editorial judgement remains available in history');
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length,0);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id=${id}`).length,0);
  const [hook]=await sql`SELECT value FROM settings WHERE key=${`date-hook:${id}`}`;
  assert.deepEqual(hook!.value.previousStoryIds,[story!.id]);
  assert.deepEqual(await pushSelected(id),{status:'skipped',reason:'not live'});
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE subject_id=${id}`).length,0);
  assert.deepEqual(after.jobs.filter(job=>job.name!==QUEUES.digest),before.jobs.filter(job=>job.name!==QUEUES.digest));
  assert.equal((await correctPublicationDate(id,input,'test')).status,'corrected');
});

// Archiving (an old date) and retracting (no date) both remove live evidence: neither overwrites manual
// grouping or races an active processor.
for(const [change,publishedAt] of [['archiving',corrected],['retracting',null]] as const) test(`${change} a misdated article respects manual grouping and active processing`,async()=>{
  const id=await misdatedFixture();
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${id},'Reviewed grouping','test')`;
  const plan=(await previewPublicationDateCorrection(id,publishedAt))!;
  const input={version:plan.version,hash:plan.hash,publishedAt,requestId:`${change}-${id}`,reason:'Verified original publication'};
  await assert.rejects(correctPublicationDate(id,input,'test'),/人工/);
  await sql`DELETE FROM grouping_overrides WHERE article_id=${id}`;
  await sql`UPDATE articles SET grouping_status='pending' WHERE id=${id}`;
  await assert.rejects(correctPublicationDate(id,input,'test'),/处理/);
  assert.equal((await sql`SELECT backfill FROM articles WHERE id=${id}`)[0]!.backfill,false);
});

// A source can repost a four-day-old article: it is already stale on discovery even within seven days.
test('verified stale-on-discovery publication inside the current week still leaves live news',async()=>{
  const id=await misdatedFixture();
  await sql`UPDATE articles SET processing_state='skipped' WHERE id=${id}`;
  const publishedAt=new Date(Date.now()-4*86400_000).toISOString();
  const plan=(await previewPublicationDateCorrection(id,publishedAt))!;
  await correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt,requestId:`week-archive-${id}`,reason:'Repost time replaced the verified original publication'},'test');
  const [a]=await sql`SELECT published_at,backfill,backfill_reason FROM articles WHERE id=${id}`;
  assert.equal(a!.published_at.toISOString(),publishedAt);
  assert.equal(a!.backfill,true);
  assert.equal(a!.backfill_reason,'stale-on-discovery');
  assert.deepEqual(await pushSelected(id),{status:'skipped',reason:'not live'});
});

// A feed can shift an original date without crossing the stale-on-discovery boundary.
test('verified recent publication corrects the date without archiving or repeating delivery',async()=>{
  const id=await misdatedFixture();
  await sql`UPDATE articles SET processing_state='skipped' WHERE id=${id}`;
  const before=await retained(id);
  const publishedAt=new Date(Date.now()-43*3600_000).toISOString();
  const plan=(await previewPublicationDateCorrection(id,publishedAt))!;
  assert.equal(plan.archive,false);
  await correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt,requestId:`fresh-date-${id}`,reason:'Original publication verified; still fresh on first discovery'},'test');
  assert.deepEqual(await retained(id),before);
  const [a]=await sql`SELECT published_at,timeline_at,discovered_at,backfill FROM articles WHERE id=${id}`;
  assert.equal(a!.published_at.toISOString(),publishedAt);
  assert.equal(a!.timeline_at.toISOString(),a!.discovered_at.toISOString());
  assert.equal(a!.backfill,false);
});

// A publisher's later edit can move a displayed publication date past the original discovery.
test('recent date correction refuses a later timestamp beyond the discovery tolerance',async()=>{
  const id=await misdatedFixture();
  const discoveredAt=new Date(Date.now()-6*3600_000);
  await sql`UPDATE articles SET discovered_at=${discoveredAt},published_at=${discoveredAt},published_at_claim=${discoveredAt},timeline_at=${discoveredAt} WHERE id=${id}`;
  await assert.rejects(previewPublicationDateCorrection(id,new Date(Date.now()-3600_000).toISOString()),/一小时|收录/);
  const [a]=await sql`SELECT published_at FROM articles WHERE id=${id}`;
  assert.equal(a!.published_at.toISOString(),discoveredAt.toISOString());
});

test('retracting a proven repost date removes live evidence while retaining material and paid decisions',async()=>{
  const id=await misdatedFixture();
  const [story]=await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'Repost date without original evidence') RETURNING id`;
  const [fact]=await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`fact-${id}`},${story!.id},'Reposted article') RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${id},'primary')`;
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${story!.id},${id},${source},${source},'editorial',now() - interval '1 minute')`;
  await publishArticle(id);
  await sql`DELETE FROM settings WHERE key=${`date-hook:${id}`}`;
  const before=await retained(id);
  const publishedAt=null;
  const plan=(await previewPublicationDateCorrection(id,publishedAt))!;
  const input={version:plan.version,hash:plan.hash,publishedAt,requestId:`retract-${id}`,reason:'Known forum repost time; original publisher currently unavailable'};
  await correctPublicationDate(id,input,'test');
  const after=await retained(id);
  for(const key of ['analyses','revisions','overrides','receipts'] as const)assert.deepEqual(after[key],before[key]);
  assert.equal(after.a!.revision,before.a!.revision);
  const [a]=await sql`SELECT published_at,published_at_claim,discovered_at,timeline_at,backfill,backfill_reason FROM articles WHERE id=${id}`;
  assert.equal(a!.published_at,null);
  assert.equal(a!.published_at_claim,null);
  assert.equal(a!.timeline_at.toISOString(),a!.discovered_at.toISOString());
  assert.equal(a!.backfill,true);
  assert.equal(a!.backfill_reason,'unknown-publication-time');
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length,0);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id=${id}`).length,0);
  assert.deepEqual(await pushSelected(id),{status:'skipped',reason:'not public selected'});
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE subject_id=${id}`).length,0);
  assert.deepEqual(after.jobs.filter(job=>job.name!==QUEUES.digest),before.jobs.filter(job=>job.name!==QUEUES.digest));
  assert.deepEqual(await correctPublicationDate(id,input,'test'),{articleId:id,revision:before.a!.revision,status:'corrected',publishedAt:null});
});

test('retraction preserves imported history',async()=>{
  const history=await fixture();
  await sql`UPDATE articles SET backfill=true,backfill_reason='first-import',discovered_at=published_at+interval '30 days' WHERE id=${history}`;
  await assert.rejects(previewPublicationDateCorrection(history,null),/历史/);
});

// A judgement that finished without grouping (blocked, or relevance unknown) is not active processing.
for(const settled of ['blocked','unknown'] as const) test(`a completed ${settled} judgement can retract its date without starting new work`,async()=>{
  const id=await misdatedFixture();
  await sql`UPDATE articles SET grouping_status='pending' WHERE id=${id}`;
  await sql`UPDATE analyses SET relevance=${settled==='blocked'?'block':'unknown'} WHERE article_id=${id}`;
  if(settled==='blocked')await sql`UPDATE articles SET processing_state='blocked' WHERE id=${id}`;
  const before=await retained(id);
  const plan=(await previewPublicationDateCorrection(id,null))!;
  const result=await correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt:null,requestId:`${settled}-${id}`,reason:'Proven repost date'},'test');
  assert.equal(result.status,'corrected');
  const after=await retained(id);
  for(const key of ['analyses','receipts'] as const)assert.deepEqual(after[key],before[key]);
  assert.deepEqual(after.jobs.filter(job=>job.name!==QUEUES.digest),before.jobs.filter(job=>job.name!==QUEUES.digest));
});

test('a first import published the day it was found is news: its date is corrected and it stays a first import',async()=>{
  const id=await misdatedFixture();
  await sql`UPDATE articles SET backfill=true,backfill_reason='first-import' WHERE id=${id}`;
  await publishArticle(id);
  await sql`DELETE FROM settings WHERE key=${`date-hook:${id}`}`;
  const publishedAt=new Date(Date.now()-20*3600_000).toISOString();
  const plan=(await previewPublicationDateCorrection(id,publishedAt))!;
  assert.equal(plan.archive,false);
  await correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt,requestId:`first-import-${id}`,reason:'Original publication verified'},'test');
  const [a]=await sql`SELECT published_at,timeline_at,backfill,backfill_reason FROM articles WHERE id=${id}`;
  assert.equal(a!.published_at.toISOString(),publishedAt);
  assert.equal(a!.timeline_at.toISOString(),publishedAt);
  assert.equal(a!.backfill,true);
  assert.equal(a!.backfill_reason,'first-import');
});

test('a settled post that never needs grouping can have its date corrected',async()=>{
  const discoveredAt=new Date(Date.now()-3*3600_000);
  const {articleId:id}=await upsertMaterial({sourceId:isolated,url:`https://example.test/${tag()}`,title:'Isolated post',bodyText:'Body',bodyStatus:'ok',via:'fetch',publishedAt:discoveredAt,discoveredAt});
  await sql`UPDATE articles SET processing_state='skipped' WHERE id=${id}`;
  await publishArticle(id);
  const publishedAt=new Date(discoveredAt.getTime()-3600_000).toISOString();
  const plan=(await previewPublicationDateCorrection(id,publishedAt))!;
  const result=await correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt,requestId:`isolated-${id}`,reason:'Original publication verified'},'test');
  assert.equal(result.status,'corrected');
  const [a]=await sql`SELECT published_at,grouping_status FROM articles WHERE id=${id}`;
  assert.equal(a!.published_at.toISOString(),publishedAt);
  assert.equal(a!.grouping_status,'pending');
});
