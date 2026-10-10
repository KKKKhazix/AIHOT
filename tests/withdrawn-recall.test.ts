// Withdrawn history stays stored, but must not supply evidence for a later identity decision.
import { stub } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { candidateViews, recallFacts, relatedPosts } from '@aihot/backend/events/recall';
import { consolidate, linkRelatedStories } from '@aihot/backend/events/consolidate';
const prompts: string[] = [];
const provider = await stub((_hit,request) => {
  prompts.push(JSON.parse(request.body).messages[1].content);
  return { choices: [{ message: { content: JSON.stringify({a:'fixture',b:'fixture',relation:'UNRELATED',difference:'different fixture facts',confidence:1}) } }], usage: {prompt_tokens:1,completion_tokens:1} };
});
for (const name of ['DEEPSEEK','XIAOMI_MIMO','LLM']) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = 'test-key';
}
after(async()=>{await provider.close(); await closeDb();});
async function fixture() {
  const key=randomUUID();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${key},'Withdrawal fixture','rss','T1','editorial')`;
  const [story]=await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${key},${key},now(),now()) RETURNING id`;
  const [fact]=await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${key},${story.id},${key}) RETURNING id`;
  return {key,storyId:Number(story.id),factId:Number(fact.id)};
}
async function report(f:Awaited<ReturnType<typeof fixture>>, label:string, visibility:'public'|'summary-only'|'withdrawn'|null, options:{role?:string;age?:number;identity?:string;factId?:number}={}) {
  const id=randomUUID(),url='https://example.invalid/'+id,title=f.key+' '+label;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${id},${f.key},${options.identity??id},${url},${title},now(),now()-make_interval(days=>${options.age??0}))`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,title_zh,summary_zh,output) VALUES(${id},1,'rule',${title},'',${sql.json({scope:'single'})})`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${options.factId??f.factId},${id},${options.role??'report'})`;
  if(visibility!==null) await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,visibility,discovered_at,timeline_at,sort_at) SELECT id,title,'',source_id,'news',url,${visibility},discovered_at,timeline_at,timeline_at FROM articles WHERE id=${id}`;
  return {id,url,title};
}
const recalled=(f:Awaited<ReturnType<typeof fixture>>)=>[{factId:f.factId,storyId:f.storyId,factTitle:f.key,score:1}];
test('withdrawn primary yields to an active report and does not count as evidence',async()=>{
  const f=await fixture(); await report(f,'old primary','withdrawn',{role:'primary',age:2}); const valid=await report(f,'active report','public',{age:1});
  const [view]=await candidateViews(recalled(f)); assert.equal(view.report.title,valid.title); assert.equal(view.members,1);
});
test('all-withdrawn facts leave future recall and return when restored',async()=>{
  const f=await fixture(); const a=await report(f,'same query','withdrawn',{role:'primary'});
  const before=await recallFacts('query-'+f.key,a.title,0,1000); assert.equal(before.some(r=>r.factId===f.factId),false);
  await sql`UPDATE publications SET visibility='public' WHERE article_id=${a.id}`;
  const after=await recallFacts('query-'+f.key,a.title,0,1000); assert.equal(after.some(r=>r.factId===f.factId),true);
});
test('summary-only and reports without publication retain existing recall eligibility',async()=>{
  const a=await fixture(),b=await fixture(); const x=await report(a,'summary','summary-only'); const y=await report(b,'unpublished',null);
  const rows=await recallFacts('query-'+a.key,x.title,0,1000); assert.equal(rows.some(r=>r.factId===a.factId),true); const internal=await recallFacts('query-'+b.key,y.title,0,1000); assert.equal(internal.some(r=>r.factId===b.factId),true);
});
test('same URL cannot route directly through a withdrawn report',async()=>{
  const f=await fixture(); const a=await report(f,'same URL','withdrawn');
  const rows=await relatedPosts({id:'new-'+f.key,url:a.url,x_post:null}); assert.equal(rows.sameUrl,null);
});
test('X reply and quote cannot boost a withdrawn report',async()=>{
  const f=await fixture(); const identity='919177'+Date.now(); await report(f,'post','withdrawn',{identity:'x:'+identity});
  const rows=await relatedPosts({id:'new-'+f.key,url:'https://example.invalid/new',x_post:{replyTo:identity,quoted:{url:'https://x.com/example/status/'+identity}}}); assert.deepEqual(Array.from(rows.referenced),[]);
});
test('a withdrawn-only earlier fact does not claim the root of an active candidate',async()=>{
  const f=await fixture(); await report(f,'old root','withdrawn',{role:'primary',age:2});
  const [next]=await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${f.storyId},'active root') RETURNING id`;
  const a=await report(f,'active root','public',{role:'primary',age:1,factId:Number(next.id)});
  const [view]=await candidateViews([{factId:Number(next.id),storyId:f.storyId,factTitle:a.title,score:1}]); assert.equal(view.storyRoot,true);
});
test('withdrawn similarity hits do not consume a valid top candidate slot',async()=>{
  const old=await fixture(),active=await fixture(); const a=await report(old,'expired','withdrawn'),b=await report(active,'active','public');
  const query=randomUUID()+' 模型发布架构参数推理上下文完整技术说明';
  for(const [row,title] of [[a,query],[b,query+' 新补充']] as const) {
    await sql`UPDATE publications SET title=${title} WHERE article_id=${row.id}`;
  }
  const rows=await recallFacts('query-'+old.key,query,0,1); assert.equal(rows.length,1); assert.equal(rows[0].factId,active.factId);
});

test('later story comparison uses an active root report instead of its withdrawn primary',async()=>{
  const a=await fixture(),b=await fixture();
  const old=await report(a,'withdrawn root primary','withdrawn',{role:'primary',age:2});
  const active=await report(a,'active root report','public',{age:1}); await report(b,'other story','public');
  prompts.length=0; const out=await consolidate([a.storyId,b.storyId]);
  assert.equal(out.length,1); assert.equal(prompts.length,1); assert.equal(prompts[0].includes(old.title),false); assert.equal(prompts[0].includes(active.title),true);
});
test('an all-withdrawn story supplies no material for a new paid story comparison',async()=>{
  const a=await fixture(),b=await fixture(); await report(a,'withdrawn story','withdrawn'); await report(b,'active story','public');
  prompts.length=0; assert.deepEqual(await consolidate([a.storyId,b.storyId]),[]); assert.equal(prompts.length,0);
});

test('withdrawn bridge reports cannot create a new related link, while saved links remain',async()=>{
  const a=await fixture(),b=await fixture(); await report(b,'other live event','public');
  const reports=[];
  for(const label of ['bridge one','bridge two']) {
    const r=await report(a,label,'withdrawn'); reports.push(r);
    await sql`INSERT INTO grouping_decisions(article_id,verdict,candidates) VALUES(${r.id},'new-story',${sql.json([{id:b.factId,relation:'SAME_STORY',confidence:1}])})`;
  }
  await linkRelatedStories();
  const before=await sql`SELECT * FROM story_links WHERE story_id=${a.storyId} AND other_id=${b.storyId}`; assert.equal(before.length,0);
  for(const r of reports) await sql`UPDATE publications SET visibility='public' WHERE article_id=${r.id}`;
  await linkRelatedStories();
  const restored=await sql`SELECT * FROM story_links WHERE story_id=${a.storyId} AND other_id=${b.storyId}`; assert.equal(restored.length,1);
  for(const r of reports) await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${r.id}`;
  await linkRelatedStories();
  const history=await sql`SELECT * FROM story_links WHERE story_id=${a.storyId} AND other_id=${b.storyId}`; assert.equal(history.length,1);
});
