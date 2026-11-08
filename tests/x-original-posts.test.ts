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
import { textToHtml } from "@aihot/backend/content/sanitize";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { POLICY } from "@aihot/site";
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

/** A post found and published a minute ago (released by `released`): a rolling window that ends at the reader's clock holds it. */
async function post(name: string, text: string, sourceId = source, quoted?: { authorName: string; handle: string; url: string; text: string }) {
  const url = `https://x.com/fixture/status/${name}-${source}`;
  const minuteAgo = new Date(Date.now() - 60_000);
  const material = await upsertMaterial({ sourceId, url, title: text, bodyText: text, bodyStatus: "ok", via: "fetch", publishedAt: minuteAgo, discoveredAt: minuteAgo,
    xPost: { tweetId: name, authorName: "Fixture", handle: "fixture", text, ...(quoted ? { quoted } : {}),
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

test("a saved X Article reaches public readers and full-text exports without buying it again", async () => {
  const { id } = await post("saved-article", "An introduction to the measured research results. https://x.com/i/article/987654");
  const text = "SAVED_ARTICLE_EVIDENCE: measured results and limitations from the published long article.";
  await sql`UPDATE articles SET x_article=${sql.json({ title: "Saved research article", text })},
    body_text=${`https://x.com/i/article/987654\n\n# Saved research article\n\n${text}`} WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
    VALUES(${id},1,'model','pass','已保存的研究长文','已保存正文的摘要',${SELECTING_SCORE},true)`;
  await publishArticle(id, released());
  // Existing X translations cover only x_post.text, not the saved long article.
  await sql`INSERT INTO translations(article_id,revision,body_text,body_html,complete,origin)
    VALUES(${id},1,'旧的帖子介绍译文','<p>旧的帖子介绍译文</p>',true,'model')`;
  const before = provider.hits();
  for (const suffix of ["", "/original"]) {
    const detail = (await app.inject({ method: "GET", url: `/api/site/items/${id}${suffix}` })).json();
    assert.ok(detail.body?.original?.includes(text), "a translated introduction cannot replace the saved long article");
    assert.equal(detail.hasTranslation, false, "the introduction is not a complete article translation");
  }
  for (const path of [`/items/${id}/markdown`, "/feed/full.xml"]) {
    const res = await app.inject({ method: "GET", url: path });
    assert.equal(res.statusCode, 200, path);
    assert.ok(res.body.includes(text), path);
  }
  assert.equal(provider.hits(), before, "reading already stored content cannot buy another response");
});

test("a saved X Article with its layout reads as an article in every exit", async () => {
  const { id } = await post("laid-out-article", "https://x.com/i/article/987656");
  const text = "LAID_OUT_EVIDENCE: the long article's own words.";
  const html = '<figure><img src="https://pbs.twimg.com/media/cover.jpg" alt=""></figure><h2>First part</h2><p><strong>LAID_OUT_EVIDENCE</strong>: the long article\'s own words.</p>';
  await sql`UPDATE articles SET x_article=${sql.json({ title: "Laid out article", text, html })},
    body_text=${`https://x.com/i/article/987656\n\n# Laid out article\n\n${text}`} WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
    VALUES(${id},1,'model','pass','排好版的长文','排好版的长文摘要',${SELECTING_SCORE},true)`;
  await publishArticle(id, released());
  const detail = (await app.inject({ method: "GET", url: `/api/site/items/${id}` })).json();
  const body: string = detail.body.original ?? detail.body.zh;
  assert.equal(detail.x.article, true, "the page reads like an article, under its headline");
  assert.match(body, /<h2 id="sec-1">First part<\/h2>/);
  assert.match(body, /<strong>LAID_OUT_EVIDENCE<\/strong>/);
  assert.match(body, /<img [^>]*src="[^"]*cover\.jpg/, "the cover comes along");
  assert.ok(!body.includes("x.com/i/article") && !body.includes("【X 长文】"), "neither the link the article stands for nor our mark");
  assert.deepEqual(detail.outline.map((o: { text: string }) => o.text), ["First part"]);
  const markdown = (await app.inject({ method: "GET", url: `/items/${id}/markdown` })).body;
  assert.match(markdown, /\n## First part\n/);
  assert.match(markdown, /\*\*LAID\\_OUT\\_EVIDENCE\*\*/);
  assert.ok(!markdown.includes("【X 长文】"));
  assert.ok((await app.inject({ method: "GET", url: "/feed/full.xml" })).body.includes("<h2>First part</h2><p><strong>LAID_OUT_EVIDENCE</strong>"));
});


test("a quoted post reads on its item page as the post itself does, and as the full RSS gives it", async () => {
  const quoted = { authorName: "Quoted", handle: "quoted", url: "https://x.com/quoted/status/77",
    text: "First paragraph.\n\nCode: https://github.com/browser-use/jev-ultrafast-reference-implementation\n- one\n- two" };
  const { id } = await post("quote-reads", "QUOTE_READS worth reading", source, quoted);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
    VALUES(${id},1,'model','pass','值得一读','值得一读',${SELECTING_SCORE},true)`;
  await publishArticle(id, released());
  const html = textToHtml(quoted.text);
  assert.match(html, /<p>Code: <a href="https:\/\/github\.com\/browser-use\/jev-ultrafast-reference-implementation" [^>]*>github\.com\/browser-use\/jev-ul…<\/a><\/p><ul>/);
  const detail = (await app.inject({ method: "GET", url: `/api/site/items/${id}` })).json();
  assert.deepEqual(detail.x.quoted, { authorName: "Quoted", handle: "quoted", url: quoted.url, html, translationHtml: null });
  assert.ok((await app.inject({ method: "GET", url: "/feed/full.xml" })).body.includes(html));
});

test("saved long articles remain private when only the X post itself may be shown", async () => {
  const restricted = `${source}-restricted`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext,next_fetch_at)
    VALUES (${restricted},'Restricted article test','x_search','T1','editorial',false,true,'2100-01-01')`;
  const { id } = await post("restricted-article", "https://x.com/i/article/987655", restricted);
  const text = "RESTRICTED_ARTICLE_EVIDENCE: saved for analysis, not licensed for full-text display.";
  await sql`UPDATE articles SET x_article=${sql.json({ title: "Restricted long article", text })}, body_text=${text} WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
    VALUES(${id},1,'model','pass','受限长文标题','许可内的简短摘要',${SELECTING_SCORE},true)`;
  await publishArticle(id, released());
  const before = provider.hits();
  for (const path of [`/api/site/items/${id}`, `/api/site/items/${id}/original`, `/items/${id}/markdown`, "/feed/full.xml"]) {
    const res = await app.inject({ method: "GET", url: path });
    assert.equal(res.statusCode, 200, path);
    assert.ok(!res.body.includes(text), `${path}: a saved article is not a grant of full-text permission`);
  }
  // A site that counts an X post as full text (POLICY.xPostIsFullText) shows none of it here, its link included.
  if (!POLICY.xPostIsFullText) {
    const detail = (await app.inject({ method: "GET", url: `/api/site/items/${id}/original` })).json();
    assert.ok(detail.body?.original?.includes("https://x.com/i/article/987655"), "the original post keeps its link");
  }
  assert.equal(provider.hits(), before);
});
