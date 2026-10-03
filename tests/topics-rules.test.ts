// Milestone failures to guard before implementing the new deterministic rules:
// - a useful tutorial, opinion or trend list is presented as a historical milestone;
// - a stronger later report moves an event's date, or an explicit occurrence loses to collection time;
// - cached titles survive a score/tag/subject correction, while the selected list should stay readable.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTopicPage } from "@aihot/backend/publication/topics";
import { overrideFields } from "@aihot/backend/admin/content";

const T = tag();
const SOURCE = `test-topic-rules-${T}`;
const now = new Date();
const at = new Date(now.getTime() - 6 * 3600_000);
let serial = 0;
let cached: string;
let cachedFact: number;
before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,owner_entity_id,next_fetch_at)
    VALUES (${SOURCE},'Official','rss','T1','editorial','qwen','2100-01-01')`;
  cachedFact = await fact(null, "qwen");
  cached = await report({ company: "qwen", title: "Qwen 发布新模型", factId: cachedFact, score: 90 });
  await loadTopicPage("qwen", 1); // Warm once; all corrections below happen before expiry.
});
after(async () => { await stopBoss(); await closeDb(); });

async function fact(storyId: number | null, subject: string, occurred: Date | null = null, action = "发布"): Promise<number> {
  const [f] = await sql<{id: number}[]>`INSERT INTO facts (public_id,story_id,title,subject,action,object,occurred_at)
    VALUES (${`f-${randomUUID()}`},${storyId},'模型发布',${subject},${action},'测试模型',${occurred}) RETURNING id`;
  return f!.id;
}
async function story() {
  const id = randomUUID();
  const [s] = await sql<{id: number}[]>`INSERT INTO stories (public_id,title,first_report_at,latest_at) VALUES (${id},'新模型',${at},${at}) RETURNING id`;
  return { id: s!.id, publicId: id };
}
async function report(o: {company?: string; title: string; category?: string; tags?: string[]; score?: number; factId?: number; published?: Date; timeline?: Date}) {
  const published = o.published ?? at;
  const timeline = o.timeline ?? published;
  const {articleId} = await upsertMaterial({sourceId: SOURCE,url:`https://example.com/topic-rules-${T}-${++serial}`,title:o.title,
    publishedAt:published,bodyText:'Supported report',bodyHtml:'<p>Supported report</p>',bodyStatus:'ok',via:'fetch'});
  await sql`UPDATE articles SET discovered_at=${timeline},timeline_at=${timeline},grouped_at=now() WHERE id=${articleId}`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,subjects,tags)
    VALUES (${articleId},1,'rule','pass',${o.category ?? 'ai-models'},${o.title},'新的消息',${o.score ?? 90},true,
    ${o.company ? [o.company] : []},${o.tags ?? ['模型发布']})`;
  if (o.factId) await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${o.factId},${articleId},'report')`;
  await publishArticle(articleId,{releasedAt:new Date(timeline.getTime()+60000)});
  return articleId;
}
const page = async (slug: string) => {const p=await loadTopicPage(slug,1,new Date()); assert.ok(p); return p;};

test("tutorial, opinion and trend topics keep selected reading without manufacturing milestones or SEO highlights", async () => {
  for (const [slug, category, tag] of [['tutorials','tip','教程/实践'],['opinions','opinion','大佬观点'],['trends','opinion','现象/趋势']]) {
    const id=await report({title:`高分内容 ${slug}`,category,tags:[tag!],score:99});
    const p=await page(slug!);
    assert.deepEqual(p.chronicle,[],slug);
    assert.deepEqual(p.highlights,[],`${slug}: search snippets use the same milestone rules`);
    assert.ok(p.items.some(r=>r.id===id));
  }
});

// A release can include a migration guide or benchmark result; those suffixes do not change its main action.
test("launches keep their milestones when the headline also mentions supporting guides or benchmarks", async () => {
  const launch = await report({company:'anthropic',title:'Anthropic 发布 Claude Sonnet 5.5，附模型选型与迁移指南',score:87});
  const model = await report({company:'kimi',title:'Kimi 最强模型 K3 发布，Frontend Code Arena 跑分登顶',score:79});
  const product = await report({company:'kimi',title:'Kimi Code 焕新升级（附视频教程）',category:'ai-products',tags:['产品更新'],score:76});
  const tutorial = await report({company:'anthropic',title:'Claude Code 使用指南：如何构建应用',category:'ai-products',tags:['产品更新'],score:99});
  const view = await fact(null,'anthropic',null,'opinion');
  const opinion = await report({company:'anthropic',title:'Anthropic CEO 谈未来的模型福利',factId:view,score:99});
  const anthropic=await page('anthropic');
  assert.deepEqual(anthropic.milestones.map(m=>m.href),[`/items/${launch}`]);
  assert.ok(anthropic.items.some(r=>r.id===tutorial)&&anthropic.items.some(r=>r.id===opinion));
  const kimi=await page('kimi');
  assert.deepEqual(new Set(kimi.milestones.map(m=>m.href)),new Set([model,product].map(id=>`/items/${id}`)));
});

test("event dates use an explicit occurrence, otherwise the earliest publication, and do not move with the stronger report", async () => {
  const month=beijingDate(now).slice(0,7);
  const boundary=new Date(`${month}-01T00:00:00+08:00`);
  const earlier=new Date(boundary.getTime()-40*86400000);
  const later=new Date(boundary.getTime()-2*86400000);
  const occurred=new Date(earlier.getTime()-86400000);
  for(const [company,useOccurrence,sameFact] of [['meta',true,false],['nvidia',false,false],['microsoft',false,true]] as const) {
    const event=await story();
    const original=await fact(event.id,company,useOccurrence?occurred:null);
    const follow=sameFact ? original : await fact(event.id,company);
    const old=await report({company,title:`${company} 发布模型`,published:earlier,timeline:new Date(earlier.getTime()+3600000),factId:original,score:69});
    const stronger=await report({company,title:`${company} 新模型的正式公告`,published:later,factId:follow,score:95});
    const p=await page(company);
    const entries=p.milestones.filter(m=>m.href===`/story/${event.publicId}`);
    assert.equal(entries.length,1);
    assert.equal(entries[0]!.date,beijingDate(useOccurrence?occurred:earlier));
    assert.ok(p.items.some(r=>r.id===stronger));
    if (sameFact) assert.ok(!p.items.some(r=>r.id===old),'the old fact representative no longer holds a selected seat');
    else assert.ok(p.items.some(r=>r.id===old));
  }
});

test("cached milestone eligibility follows current score, launch tag and fact subject corrections", async () => {
  assert.ok((await loadTopicPage('qwen',1))?.milestones.length);
  await sql`UPDATE analyses SET score=1 WHERE article_id=${cached}`;
  await publishArticle(cached,{releasedAt:at});
  assert.deepEqual((await loadTopicPage('qwen',1))?.milestones,[],'score changes apply without waiting for cached counts');
  await sql`UPDATE analyses SET score=90 WHERE article_id=${cached}`;
  await overrideFields(cached,{fields:{tags:['评测/基准','entity:qwen']},version:0,reason:'实际是评测'},'topic-rules');
  assert.deepEqual((await loadTopicPage('qwen',1))?.milestones,[],'the current launch tag is checked');
  await overrideFields(cached,{fields:{tags:['模型发布','entity:qwen']},version:1,reason:'恢复已核实发布'},'topic-rules');
  await sql`UPDATE facts SET subject='OpenAI' WHERE id=${cachedFact}`;
  assert.deepEqual((await loadTopicPage('qwen',1))?.milestones,[],'a known different action subject cannot remain a Qwen milestone');
  assert.ok((await loadTopicPage('qwen',1))?.items.some(r=>r.id===cached),'chronicle rules do not remove the selected report');
});
