// Failure modes, fixed before changing public loaders or prefetch:
// - hydration repeats SSR; returning to an SSR list still needs the network;
// - query variants mix content/SEO, or restores lose their anchor;
// - intent no longer loads data, scroll-through touches download it, or a failed prefetch breaks the current page;
// - visits renew deadlines, expired/errors stay cached, refresh stops working, or retention grows without a bound;
// - Agent tabs refetch health, choose an invalid panel or leave canonical/history behind;
// - search downloads two whole pages, requests before opening, or never retries/updates suggestions.
// Reader work failures fixed before changing enhancement and return-position code:
// - offscreen code downloads/runs immediately, visible code stays plain, or raw copying changes;
// - tiny/linked pictures become zoom buttons, delayed pictures rescan the whole article, or language changes keep old handlers;
// - a deep return scans every earlier card, loses its anchor, or folded dates confuse the anchor search.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect, type Browser } from "@playwright/test";
import type { FeedItemSummary, SiteItemDetail, ReportDetail } from "@aihot/contracts/site";

const at = '2026-10-04T08:00:00.000Z';
const item: FeedItemSummary = {id:'navigation-fixture',title:'性能检查文章',summary:'固定摘要',reason:'固定推荐理由',source:{name:'Fixture'},publishedAt:at,timelineAt:at,category:'ai-models',tags:[],score:80,selected:true,channel:'news',x:null};
const detail: SiteItemDetail = {...item,x:null,originalTitle:'Fixture article',links:{original:'https://example.org/article'},discoveredAt:at,story:null,readingMode:'full',author:null,body:{zh:'<p>固定正文</p>',original:null,zhKind:'translation',complete:true},outline:[],relatedStories:[],topics:[],indexable:true,markdownAvailable:true,group:null,hasTranslation:true,bodyLanguage:'zh'};
const codeSource='import json\n\nwith open("data.json") as file:\n    data = json.load(file)\n\nfor record in data:\n    print(record["title"])\n';
const readerBody=Array.from({length:30},(_,i)=>`<p>阅读段落 ${i}：先阅读文章，再查看后面的代码和图片。正文保持可读，图片和代码在需要时增强。</p>`).join('')
  +`<pre><code>${codeSource}</code></pre><pre><code>x = 1</code></pre>`
  +Array.from({length:12},(_,i)=>`<img src="/reader-image/${i}.svg" alt="正文配图 ${i}" width="640" height="360" loading="lazy">`).join('')
  +'<img src="/reader-image/tiny.svg" alt="小图标" width="16" height="16" loading="lazy"><a href="https://example.org"><img src="/reader-image/linked.svg" alt="链接图片" width="640" height="360" loading="lazy"></a>';
const report = (kind:'daily'|'weekly'|'monthly'): ReportDetail => ({kind,key:kind==='daily'?'2026-10-04':kind==='weekly'?'2026-W40':'2026-10',issueNumber:1,title:'Fixture '+kind,generatedAt:at,lead:{title:'Fixture '+kind,leadParagraph:'Fixture report'},leadItemId:null,overview:null,highlights:[],sections:[],flashes:[],cover:null,metrics:{},readingMinutes:1,prev:null,next:null});
const hits: string[] = [];
let suggestionsVersion=1;
let failing='';
let ttl=60;
let web:ChildProcess;
let logs='';
let origin:string;
let chrome:Browser;
let safari:Browser;
const api=createServer((req,res)=>{
  const url=new URL(req.url!,'http://local');
  const p=url.pathname;
  res.setHeader('Content-Type','application/json');
  if(p==='/api/site/meta') return res.end(JSON.stringify({changelogVersion:'fixture'}));
  if(p==='/api/site/track'){res.statusCode=204;return res.end();}
  hits.push(req.url!);
  if(p===failing){res.statusCode=503;return res.end(JSON.stringify({code:'unavailable'}));}
  if(p==='/api/health')return res.end('{}');
  if(p==='/api/site/search/suggestions')return res.end(JSON.stringify({topics:[{slug:'openai',name:'OpenAI',group:'company'}],hot:[{rank:1,title:'建议版本 '+suggestionsVersion,to:'/story/fixture'}]}));
  if(p==='/api/site/topics')return res.end(JSON.stringify({groups:[],topics:[{slug:'openai',name:'OpenAI',group:'company',definition:'Fixture',brand:null,total:0,recent:0,indexable:false,latest:null}]}));
  if(p==='/api/site/hot')return res.end(JSON.stringify({computedAt:at,windowHours:48,entries:[{rank:1,story:{publicId:'fixture',title:'建议版本 '+suggestionsVersion},heat:10,trend:'flat',trendPct:0,badges:[],participantCount:0,sourceCount:0,sourceNames:[],participants:[],spark:[],summary:null,latest:null,cover:null}]}));
  if(p==='/api/site/timeline'){
    res.setHeader('X-Accel-Expires','@'+(Math.floor(Date.now()/1000)+ttl));
    const category=url.searchParams.get('category');
    const shown={...item,title:category?'分类 '+category:'性能检查文章'};
    if(url.searchParams.get('tag')==='long-reading'){
      const cards=Array.from({length:180},(_,i)=>({key:'long-'+i,anchorAt:i<60?at:'2026-10-03T08:00:00.000Z',item:{...item,id:'long-'+i,title:'长列表文章 '+i,summary:'用于核实深处阅读返回的固定摘要。'.repeat(3)},group:null}));
      return res.end(JSON.stringify({filters:{channel:'all',category:null,tag:'long-reading'},cards,nextCursor:null,hot:null,dayCounts:{'2026-10-04':60,'2026-10-03':120}}));
    }
    return res.end(JSON.stringify({filters:{channel:'all',category,tag:null},cards:[{key:shown.id,anchorAt:at,item:shown,group:null}],nextCursor:null,hot:null,dayCounts:{'2026-10-04':1}}));
  }
  if(p==='/api/site/pool'){
    const page=Number(url.searchParams.get('page')||1);
    return res.end(JSON.stringify({filters:{channel:'all',category:null,tag:null,q:null,tab:'time'},items:[{...item,title:'全部第 '+page+' 页'}],page,pageCount:3,total:3,todayCount:1,freshness:at}));
  }
  if(p==='/api/site/items/navigation-fixture')return res.end(JSON.stringify(detail));
  if(p==='/api/site/items/navigation-fixture/original')return res.end(JSON.stringify({...detail,body:{zh:null,original:'<p>Original fixture</p>',zhKind:null,complete:true},bodyLanguage:'original'}));
  if(p==='/api/site/items/reader-fixture')return res.end(JSON.stringify({...detail,id:'reader-fixture',title:'阅读增强检查',body:{...detail.body,zh:readerBody}}));
  if(p==='/api/site/items/reader-fixture/original')return res.end(JSON.stringify({...detail,id:'reader-fixture',title:'阅读增强检查',body:{...detail.body,zh:null,original:'<p>Original reader text</p>'},bodyLanguage:'original'}));
  if(p.startsWith('/api/site/items/long-'))return res.end(JSON.stringify({...detail,id:p.split('/').at(-1),title:'长列表详情'}));
  const kind=p.match(/^\/api\/site\/reports\/(daily|weekly|monthly)\/latest-page$/)?.[1] as 'daily'|'weekly'|'monthly'|undefined;
  if(kind){const r=report(kind);return res.end(JSON.stringify({report:r,index:[{key:r.key,issueNumber:1,title:r.title,count:0}]}));}
  res.statusCode=404;res.end(JSON.stringify({code:'not_found'}));
});

before(async()=>{
  api.listen(0,'127.0.0.1');await once(api,'listening');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=(probe.address() as AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  origin='http://127.0.0.1:'+port;
  web=spawn(process.execPath,[fileURLToPath(new URL('../server.ts',import.meta.url))],{env:{...process.env,WEB_PORT:String(port),SITE_URL:origin,API_BASE_URL:'http://127.0.0.1:'+(api.address() as AddressInfo).port},stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(logs)),15000);
    web.once('exit',()=>{clearTimeout(timer);reject(new Error(logs));});
    web.stderr!.on('data',x=>logs+=String(x));
    web.stdout!.on('data',x=>{logs+=String(x);if(logs.includes('"msg":"web started"')){clearTimeout(timer);resolve();}});
  });
  chrome=await chromium.launch({channel:'chromium'});safari=await webkit.launch();
});
after(async()=>{
  await chrome?.close();await safari?.close();
  if(web?.exitCode===null){web.kill('SIGTERM');await once(web,'exit');}
  api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));
});

for(const [engine,width] of [['chromium',1280],['webkit',390]] as const){
  test(`SSR list and visited query variants return offline without another read: ${engine}`,async()=>{
    const context=await (engine==='chromium'?chrome:safari).newContext({viewport:{width,height:844}});
    const page=await context.newPage();
    try{
      const start=hits.length;
      await page.goto(origin+'/');
      await expect(page.getByRole('link',{name:'性能检查文章',exact:true})).toBeVisible();
      await page.getByRole('link',{name:'性能检查文章',exact:true}).click();
      await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
      assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/timeline')).length,1,'hydration reuses the SSR read');
      await context.setOffline(true);
      await page.goBack();
      await expect(page.getByRole('link',{name:'性能检查文章',exact:true})).toBeVisible({timeout:1500});
      assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/timeline')).length,1,'returning to an SSR list needs no new data request');
      await context.setOffline(false);
      if(width===390)await page.getByRole('button',{name:/^筛选/}).click();
      await page.getByRole('link',{name:'模型',exact:true}).click();
      await expect(page.getByRole('link',{name:'分类 ai-models',exact:true})).toBeVisible();
      if(width===390)await page.getByRole('button',{name:/^筛选/}).click();
      await page.getByRole('link',{name:'产品',exact:true}).click();
      await expect(page.getByRole('link',{name:'分类 ai-products',exact:true})).toBeVisible();
      await context.setOffline(true);
      await page.goBack();
      await expect(page.getByRole('link',{name:'分类 ai-models',exact:true})).toBeVisible({timeout:1500});
      await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href',origin+'/?category=ai-models');
    }finally{await context.close();}
  });
}

test('hover still fetches article data, touches that move do not, and failed prefetch does not replace the current page',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    await page.goto(origin+'/');
    const link=page.getByRole('link',{name:'性能检查文章',exact:true});
    const start=hits.length;
    await link.dispatchEvent('touchstart');await link.dispatchEvent('touchmove');
    await page.getByRole('heading',{name:'精选',exact:true}).click();
    assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/items/')).length,0);
    const response=page.waitForResponse(r=>r.url().includes('/items/navigation-fixture.data'));
    await link.hover();await response;
    assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/items/')).length,1);
    await link.click();await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
    assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/items/')).length,1,'navigation reuses its intent-prefetched response');
    const fresh=await chrome.newContext();const freshPage=await fresh.newPage();
    try{
      await freshPage.goto(origin+'/');failing='/api/site/items/navigation-fixture';
      const failed=freshPage.waitForResponse(r=>r.url().includes('/items/navigation-fixture.data')&&r.status()===503);
      await freshPage.getByRole('link',{name:'性能检查文章',exact:true}).hover();await failed;
      await expect(freshPage.getByRole('heading',{name:'精选',exact:true})).toBeVisible();
    }finally{await fresh.close();}
  }finally{failing='';await context.close();}
});

test('SSR all-pages and report kinds return offline with their own content',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    await page.goto(origin+'/all');
    await page.locator('a[href="/all?page=2"]').first().click();
    await expect(page.getByRole('link',{name:'全部第 2 页',exact:true})).toBeVisible();
    await context.setOffline(true);await page.goBack();
    await expect(page.getByRole('link',{name:'全部第 1 页',exact:true})).toBeVisible({timeout:1500});
    await context.setOffline(false);await page.goto(origin+'/daily');
    await page.getByRole('link',{name:'周报',exact:true}).click();
    await expect(page.locator('#report-start')).toContainText('周报');
    await context.setOffline(true);await page.getByRole('link',{name:'日报',exact:true}).click();
    await expect(page.locator('#report-start')).toContainText('日报',{timeout:1500});
  }finally{await context.close();}
});

// A prefetch of the newly selected link must not be mistaken for an explicit refresh of that page.
// Disable HTTP reuse here: otherwise the browser cache can hide a lost document-level result.
test('intent on a selected link preserves visited data and the next revisit starts no data request',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  const requests:string[]=[];
  await context.route('**/*.data*',route=>route.continue());
  page.on('request',request=>{if(request.url().includes('.data'))requests.push(request.url());});
  try{
    await page.goto(origin+'/');
    await page.getByRole('link',{name:'模型',exact:true}).click();
    await expect(page.getByRole('link',{name:'分类 ai-models',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'模型',exact:true}).focus();
    await page.waitForTimeout(150);
    await page.getByRole('link',{name:'产品',exact:true}).click();
    await expect(page.getByRole('link',{name:'分类 ai-products',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'产品',exact:true}).focus();
    await page.waitForTimeout(150);
    const before=requests.length;
    await page.getByRole('link',{name:'模型',exact:true}).click();
    await expect(page.getByRole('link',{name:'分类 ai-models',exact:true})).toBeVisible();
    assert.deepEqual(requests.slice(before),[],'neither prefetch nor navigation may evict and reload a still-valid visited page');
  }finally{await context.close();}
});

test('a revisit never renews the original deadline; an expired read shows an error and a reload asks again',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    await page.clock.install();ttl=1;
    await page.goto(origin+'/');
    await page.getByRole('link',{name:'性能检查文章',exact:true}).click();await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
    failing='/api/site/timeline';
    await page.clock.runFor(1500);
    await page.goBack();await expect(page.getByRole('heading',{name:'暂时无法加载',exact:true})).toBeVisible();
    failing='';ttl=60;
    await page.reload();await expect(page.getByRole('link',{name:'性能检查文章',exact:true})).toBeVisible();
  }finally{ttl=60;failing='';await context.close();}
});

test('SSR freshness spent in an upstream cache is not renewed by HTML hydration',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    ttl=0;await page.goto(origin+'/');
    await page.getByRole('link',{name:'性能检查文章',exact:true}).click();await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
    const start=hits.length;ttl=60;
    await page.goBack();await expect(page.getByRole('link',{name:'性能检查文章',exact:true})).toBeVisible();
    assert.equal(hits.slice(start).filter(x=>x.startsWith('/api/site/timeline')).length,1);
  }finally{ttl=60;await context.close();}
});

test('Agent tabs finish offline with matching canonical; invalid direct tabs and anchored links keep a panel',async()=>{
  const context=await chrome.newContext();const page=await context.newPage();
  try{
    await page.goto(origin+'/agent');
    const start=hits.length;
    await context.setOffline(true);
    await page.getByRole('tablist',{name:'接入方式'}).getByRole('tab',{selected:true}).click();
    await expect(page.locator('#agent-panel')).not.toBeEmpty();
    for(const [tab,name] of [['mcp',/^MCP/],['rss',/^RSS/],['api',/^REST API/]] as const){
      const choice=page.getByRole('tab',{name});
      // The active track was exercised above; compare navigation through every remaining track.
      if(await choice.getAttribute('aria-selected')==='true')continue;
      const target=await choice.getAttribute('href');
      await choice.click();
      await expect(page).toHaveURL(origin+target,{timeout:1500});
      await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href',origin+target);
      await expect(page.locator('#agent-panel')).toHaveAttribute('aria-labelledby','agent-tab-'+tab);
      await expect(page.locator('#agent-panel')).not.toBeEmpty();
    }
    assert.equal(hits.length,start);
    await context.setOffline(false);
    await page.goto(origin+'/agent?tab=unknown');
    await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected','true');
    await expect(page.locator('#agent-panel')).not.toBeEmpty();
    await page.goto(origin+'/agent#agent-api-recovery');
    await expect(page.locator('#agent-api-recovery')).toBeVisible();
  }finally{await context.close();}
});

test('phone suggestions load only on opening, use one small read, retry failures and update on reopening',async()=>{
  const context=await safari.newContext({viewport:{width:390,height:844}});const page=await context.newPage();
  try{
    suggestionsVersion=1;await page.goto(origin+'/');
    assert.equal(hits.filter(x=>x==='/api/site/search/suggestions').length,0);
    let start=hits.length;
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('link',{name:'1 建议版本 1',exact:true})).toBeVisible();
    assert.deepEqual(hits.slice(start),['/api/site/search/suggestions']);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    suggestionsVersion=2;start=hits.length;
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('link',{name:'1 建议版本 2',exact:true})).toBeVisible();
    assert.deepEqual(hits.slice(start),['/api/site/search/suggestions']);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    failing='/api/site/search/suggestions';await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('link',{name:'1 建议版本 2',exact:true})).not.toBeVisible();
    await page.getByRole('button',{name:'取消',exact:true}).click();failing='';suggestionsVersion=3;
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('link',{name:'1 建议版本 3',exact:true})).toBeVisible();
  }finally{failing='';await context.close();}
});

for(const [engine,width] of [['chromium',1280],['webkit',390]] as const){
  test(`reader enhancements wait for visible code and update only the picture that loaded: ${engine}`,async()=>{
    const context=await (engine==='chromium'?chrome:safari).newContext({viewport:{width,height:844}});
    await context.addInitScript(()=>{
      const query=Element.prototype.querySelectorAll;
      (window as unknown as {imageScans:number}).imageScans=0;
      Element.prototype.querySelectorAll=function(this:Element,selectors:string){
        const found=query.call(this,selectors);
        if(selectors==='img'&&this.classList.contains('prose'))(window as unknown as {imageScans:number}).imageScans+=found.length;
        return found;
      } as typeof query;
    });
    const page=await context.newPage();
    const scripts:string[]=[];page.on('request',r=>{if(r.url().includes('/assets/')&&r.url().includes('highlight-'))scripts.push(r.url());});
    await page.route('**/reader-image/*.svg',route=>route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${route.request().url().endsWith('/tiny.svg')?16:640}" height="360"><rect width="640" height="360" fill="red"/></svg>`}));
    try{
      await page.goto(origin+'/items/reader-fixture');
      await expect(page.getByRole('heading',{name:'阅读增强检查',exact:true})).toBeVisible();
      await expect(page.locator('.code-block-copy')).toHaveCount(2);
      assert.deepEqual(scripts,[],'reading the introduction must not download the offscreen highlighter');
      const source=page.locator('.prose pre code').first();
      assert.equal(await source.textContent(),codeSource);
      await source.scrollIntoViewIfNeeded();
      await expect(source).toHaveClass(/hljs/);
      assert.equal(await source.textContent(),codeSource,'colouring preserves the copyable text');
      assert.equal(scripts.length,1);
      await page.locator('.code-block-copy').first().click();
      await expect(page.locator('.code-block-copy').first()).toHaveText('已复制');
      assert.equal(await page.locator('.prose pre code').nth(1).textContent(),'x = 1');
      for(let i=0;i<12;i++){
        const picture=page.locator(`.prose img[alt="正文配图 ${i}"]`);
        await picture.scrollIntoViewIfNeeded();
        await expect(picture).toHaveAttribute('role','button');
      }
      const tiny=page.locator('.prose img[alt="小图标"]');await tiny.scrollIntoViewIfNeeded();
      await expect(tiny).not.toHaveAttribute('role','button');
      await expect(page.locator('.prose a img')).not.toHaveAttribute('role','button');
      const scans=await page.evaluate(()=>(window as unknown as {imageScans:number}).imageScans);
      assert.ok(scans<=28,`each load must not rescan all 14 pictures (saw ${scans} picture visits)`);
      await page.getByRole('navigation',{name:'正文语言'}).getByRole('link',{name:'原文',exact:true}).click();
      await expect(page.getByText('Original reader text',{exact:true})).toBeVisible();
      assert.equal(await page.locator('.code-block-copy').count(),0);
    }finally{await context.close();}
  });

  test(`deep reading returns to its anchor with bounded layout reads, including folded dates: ${engine}`,async()=>{
    const context=await (engine==='chromium'?chrome:safari).newContext({viewport:{width,height:844}});
    await context.addInitScript(()=>{
      const rect=Element.prototype.getBoundingClientRect;
      (window as unknown as {cardReads:number}).cardReads=0;
      Element.prototype.getBoundingClientRect=function(){
        if(this.hasAttribute('data-card-key'))(window as unknown as {cardReads:number}).cardReads++;
        return rect.call(this);
      };
    });
    const page=await context.newPage();
    try{
      await page.goto(origin+'/?tag=long-reading');
      await expect(page.locator('[data-card-key]')).toHaveCount(180);
      await page.getByRole('button',{name:'收起10月4日',exact:true}).click();
      await expect(page.locator('[data-card-key]')).toHaveCount(120);
      await page.getByRole('link',{name:'长列表文章 160',exact:true}).scrollIntoViewIfNeeded();
      const before=await page.evaluate(()=>{
        const first=[...document.querySelectorAll<HTMLElement>('[data-card-key]')].find(e=>e.getBoundingClientRect().bottom>72)!;
        (window as unknown as {cardReads:number}).cardReads=0;
        return {key:first.dataset.cardKey!,top:first.getBoundingClientRect().top};
      });
      await page.getByRole('link',{name:'长列表文章 160',exact:true}).click();
      await expect(page.getByText('固定正文',{exact:true})).toBeVisible();
      await page.goBack();
      await expect(page.locator('[data-card-key]')).toHaveCount(120);
      await expect.poll(()=>page.locator(`[data-card-key="${before.key}"]`).evaluate((e,top)=>Math.abs(e.getBoundingClientRect().top-top),before.top)).toBeLessThan(2);
      const reads=await page.evaluate(()=>(window as unknown as {cardReads:number}).cardReads);
      assert.ok(reads<=40,`returning deep in a list must not measure every earlier card (${reads} reads)`);
      await expect(page.getByRole('button',{name:'展开10月4日',exact:true})).toBeVisible();
    }finally{await context.close();}
  });
}
