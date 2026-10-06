// Failure cases: empty/image-only or link-only posts buy invented translations; high scores route
// them through another writer; rebuilding keeps old model replies or loses pool membership; stored
// translations leak into detail/export or licensed full RSS drops media; real prose and fetched X Articles stop being written.
import { pointModels, stub, tag } from "./setup.ts";
import { analysisStep, SELECTING_SCORE } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const source = `original-post-${tag()}`;
const requests: string[] = [];
const provider = await stub((_hit, req) => {
  const step = analysisStep(req.body);
  requests.push(step);
  const content = step === "prefilter" ? { label: "UNKNOWN", reason: "No standalone text evidence" }
    : step === "score" ? { attentionScore: req.body.includes("high-score") ? SELECTING_SCORE : 12 }
    : step === "structure" ? { category: "ai-products", tags: [], subjects: [], scope: "single", fact: null }
    : step === "understand" ? { itemType: "product_update", authorRole: "principal", tags: [], editorialJudgment: "产品更新", titleZh: "实际正文标题", summaryZh: "这是实际正文的中文摘要。" }
    : "title_zh: 实际正文标题\nbody_zh: 这是实际正文的中文摘要。";
  return { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] };
});
pointModels(provider.url);
const app = await buildApp();
before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext,next_fetch_at)
    VALUES (${source},'Original post test','x_search','T1','editorial',true,true,'2100-01-01')`;
});
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

async function post(name: string, text: string) {
  const url = `https://x.com/fixture/status/${name}-${source}`;
  const material = await upsertMaterial({ sourceId: source, url, title: text, bodyText: text, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
    xPost: { tweetId: name, authorName: "Fixture", handle: "fixture", text,
      media: [{ kind: "image", url: "https://example.org/screenshot.png", width: 757, height: 549 }] } });
  return { id: material.articleId, url };
}
const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });

test("empty and link-only posts preserve originals without calling either writer, even above the selection threshold", async () => {
  for (const [name, text] of [
    ["empty", ""], ["whitespace", " \n\t "], ["link", "https://example.org/release"],
    ["high-score-links", `https://example.org/${"a".repeat(600)}\n\nhttps://example.org/second`],
  ]) {
    const { id, url } = await post(name!, text!);
    const start = requests.length;
    await analyzeArticle(id);
    const steps = requests.slice(start);
    assert.ok(!steps.includes("summarize") && !steps.includes("understand"), `${name}: no writing request`);
    const [analysis] = await sql`SELECT title_zh,summary_zh,relevance FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
    assert.equal(analysis!.title_zh, text!.trim() ? text!.replace(/\s+/g, " ").trim() : url);
    assert.equal(analysis!.summary_zh, text!.trim() ? text : "");
    assert.equal(analysis!.relevance, "pass");
    await publishArticle(id, released());
    const [p] = await sql`SELECT eligible,summary,title,body_mode FROM publications WHERE article_id=${id}`;
    assert.equal(p!.eligible, true, `${name}: original content stays in the public pool`);
    assert.equal(p!.summary, text!.trim() ? text : null);
    assert.equal(p!.body_mode, "full", "a source's full-text permission includes confirmed post media");
    const detail = (await app.inject({ method: "GET", url: `/api/site/items/${id}` })).json();
    assert.equal(detail.summary, text!.trim() ? text : null);
    assert.equal(detail.hasTranslation, false);
    assert.equal(detail.x.media.length, 1);
  }
});

test("rebuilding an image-only post replaces historical model replies across public outputs and preserves its image and address", async () => {
  const { id, url } = await post("historical-empty", "");
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
    VALUES (${id},1,'model','pass','请补充正文','抱歉，没有推文文字内容可供翻译。',${SELECTING_SCORE},true)`;
  await sql`INSERT INTO translations (article_id,revision,body_text,body_html,complete,origin)
    VALUES (${id},1,'错误译文','<p>错误译文</p>',true,'model')`;
  const before = provider.hits();
  await publishArticle(id, released());
  assert.equal(provider.hits(), before, "a projection rebuild buys no model response");
  const detail = (await app.inject({ method: "GET", url: `/api/site/items/${id}` })).json();
  assert.equal(detail.title, url);
  assert.equal(detail.summary, null);
  assert.equal(detail.body, null);
  assert.equal(detail.hasTranslation, false);
  assert.equal(detail.x.media.length, 1);
  assert.equal(detail.links.original, url);
  const feed = (await app.inject({ method: "GET", url: "/api/site/pool" })).json();
  assert.ok(JSON.stringify(feed).includes(id), "image-only post stays in the website feed");
  for (const path of ["/api/v1/items?mode=all&window=7d&limit=100", `/items/${id}/markdown`, "/feed/full.xml"]) {
    const res = await app.inject({ method: "GET", url: path });
    assert.equal(res.statusCode, 200, path);
    assert.ok(res.body.includes(url), `${path}: original address survives`);
    assert.ok(!/请补充正文|错误译文|没有推文文字内容/.test(res.body), `${path}: no model reply survives`);
    if (path.endsWith("markdown")) {
      assert.ok(res.body.includes("screenshot.png"), "the image survives export");
      assert.match(res.body, /!\[\]\(https?:\/\//, "the downloaded image link works outside the website");
    }
    if (path === "/feed/full.xml") {
      assert.ok(res.body.includes("content:encoded") && res.body.includes("screenshot.png"), "the licensed image survives full RSS");
    }
  }
});

test("real text containing links and a fetched X Article keep their normal writing path", async () => {
  for (const [name, text] of [
    ["real-text", "A model adds speech support. https://example.org/release"],
    ["long-article", "https://x.com/i/article/12345"],
  ]) {
    const { id } = await post(name!, text!);
    if (name === "long-article") await sql`UPDATE articles SET x_article=${sql.json({title:"A model release",text:"A model adds speech support with multilingual benchmarks."})} WHERE id=${id}`;
    const start = requests.length;
    await analyzeArticle(id);
    assert.ok(requests.slice(start).includes("summarize"), `${name}: real material is still translated`);
    await publishArticle(id, released());
    const [p] = await sql`SELECT summary FROM publications WHERE article_id=${id}`;
    assert.equal(p!.summary, "这是实际正文的中文摘要。");
  }
});
