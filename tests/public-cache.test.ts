// Failure modes: a reader can reuse withdrawn text for more than six minutes; stale-while-revalidate
// extends that window; report images use the static brand lifetime; conditional reads restore it.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { publishArticle } from '@aihot/backend/publication/publish';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { buildApp } from '../apps/api/src/app.ts';

const app = await buildApp();
const T = tag();
let id: string;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext)
    VALUES(${T},'Cache example','rss','T1','editorial',true,true)`;
  id = (await upsertMaterial({ sourceId:T, url:`https://example.com/${T}`,title:'公开缓存示例',
    bodyText:'允许公开的正文。'.repeat(50),bodyStatus:'ok',via:'fetch',publishedAt:new Date() })).articleId;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${id},1,'rule','pass','ai-models','公开缓存示例','公开缓存摘要',90,true)`;
  await publishArticle(id,{releasedAt:new Date(Date.now()-60000)});
  for (const [kind,key] of [['daily','2099-10-04'],['weekly','2099-W40'],['monthly','2099-10']]) {
    const entry = {itemId:id,title:'公开缓存示例',summary:'公开缓存摘要'};
    const content = kind==='daily' ? {sections:[{label:'模型',items:[entry]}],flashes:[]}
      : {headline:'公开缓存示例',themes:[{heading:'模型',storyRefs:[entry]}]};
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,origin,generated_at)
      VALUES(${kind!},${key!},now()-interval '1 day',now(),${sql.json(content)},'manual',now())`;
  }
});
after(async()=>{await app.close();await stopBoss();await closeDb();});

test('mutable content never authorizes a reader to reuse stale data beyond the withdrawal window',async()=>{
  const paths = ['/api/v1/items','/api/v1/dailies','/api/v1/dailies/2099-10-04',
    '/api/v1/weeklies/2099-W40','/api/v1/monthlies/2099-10','/api/v1/selected/snapshot',
    '/api/v1/agent/daily/2099-10-04','/api/v1/agent/weekly/2099-W40',
    '/feed.xml','/feed/full.xml','/feed/all.xml','/feed/daily.xml','/feed/weekly.xml','/feed/monthly.xml',
    `/items/${id}/markdown`, `/og/items/${id}.png`, `/og/posters/${id}.png`,
    '/og/reports/daily/2099-10-04.png','/og/reports/weekly/2099-W40.png','/og/reports/monthly/2099-10.png'];
  const failures:string[]=[];
  for (const url of paths) {
    const response=await app.inject({method:'GET',url});
    assert.equal(response.statusCode,200,url);
    const responses=[response];
    if(response.headers.etag){
      const conditional=await app.inject({method:'GET',url,headers:{'if-none-match':String(response.headers.etag)}});
      assert.equal(conditional.statusCode,304,url);
      responses.push(conditional);
    }
    for(const r of responses){
      const cc=String(r.headers['cache-control']);
      const ttl=Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)?.[1]??Infinity);
      const stale=Number(cc.match(/stale-while-revalidate=(\d+)/)?.[1]??0);
      if(ttl+stale>360) failures.push(`${url} ${r.statusCode}: ${cc}`);
    }
  }
  assert.deepEqual(failures,[], 'a cache purge cannot evict a reader\'s private HTTP cache');
});
