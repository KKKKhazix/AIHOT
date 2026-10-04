// Failure cases: a verified historical date is rejected because imported discovery time is guessed;
// correction changes content revisions, paid decisions or selection; an independent discovery sort is
// overwritten; recent/future or malformed dates and stale identities are accepted; a retry applies a
// second edit; a failed audit leaves dates, projections or cache invalidation only partly committed.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { correctPublicationDate, previewPublicationDateCorrection } from '@aihot/backend/admin/content';
import { publishArticle } from '@aihot/backend/publication/publish';
import { getBoss, stopBoss } from '@aihot/backend/jobs/queue';
import { installModules } from '@aihot/backend/modules';

const T=tag();
const source=`date-correction-${T}`;
const old='2020-02-15T00:00:00.000Z';
const corrected='2020-10-29T00:00:00.000Z';
before(async()=>{
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES(${source},'Verified date','rss','T1','editorial',true)`;
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
  assert.equal(plan.timelineFollowsPublication,true);
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
  assert.equal(plan.timelineFollowsPublication,false);
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

test('a failed audit or a changed publication decision rolls back the entire correction',async()=>{
  const id=await fixture();const plan=(await previewPublicationDateCorrection(id,corrected))!;
  const snapshot=async()=>({a:await sql`SELECT * FROM articles WHERE id=${id}`,p:await sql`SELECT * FROM publications WHERE article_id=${id}`,ledger:await sql`SELECT * FROM selected_ledger WHERE article_id=${id}`});
  const before=await snapshot();
  await sql.unsafe(`CREATE FUNCTION refuse_date_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor='refuse-date' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe('CREATE TRIGGER refuse_date_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_date_audit()');
  try{await assert.rejects(correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt:corrected,requestId:`date-${id}`,reason:'Verified byline'},'refuse-date'),/audit unavailable/);
    assert.deepEqual(await snapshot(),before);assert.equal((await sql`SELECT 1 FROM settings WHERE key=${`date-hook:${id}`}`).length,0);
  }finally{await sql.unsafe('DROP TRIGGER refuse_date_audit ON audit_log');await sql.unsafe('DROP FUNCTION refuse_date_audit()');}
  await sql`UPDATE editorial_overrides SET fields='{"selected":false}'::jsonb WHERE article_id=${id}`;
  await assert.rejects(correctPublicationDate(id,{version:plan.version,hash:plan.hash,publishedAt:corrected,requestId:`decision-${id}`,reason:'Verified byline'},'test'),/公开|选稿|decision/);
  assert.deepEqual(await snapshot(),before);
});
