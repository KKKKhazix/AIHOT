// Full-text translations follow the text: an article corrected while the model was translating the old
// wording is translated again, and a translation of an older revision is never shown as the current one.
// Links and images inside a paragraph survive the model, and the post an X item quotes is translated.
import { gate, pointModels, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { translateArticle, translatePending } from "@aihot/backend/editorial/translate";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-translate-${T}`;
const URL_ = `https://example.com/translate-${T}`;

// The model: one Chinese sentence per segment. `hold` keeps an answer back while the test revises the text.
let hold: ReturnType<typeof gate<void>> | null = null;
let asked = gate();
const asks = new Map<string, number>();
// Return a schema-valid response with the wrong segment count for selected inputs.
const misalignedAnswers = new Map<string, number>();
const provider = await stub(async (_hit, req) => {
  const { segments } = JSON.parse(JSON.parse(req.body).messages[1].content) as { segments: string[] };
  if (hold) {
    asked.open();
    await hold.promise;
  }
  const bad = [...misalignedAnswers.entries()].find(([marker, remaining]) => remaining > 0 && segments.some((s) => s.includes(marker)));
  if (bad) {
    misalignedAnswers.set(bad[0], bad[1] - 1);
    return { id: "stub-bad-alignment", choices: [{ message: { content: '{"t":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
  }
  const t = segments.map((s) => {
    // A block with a link and an image: the first answer drops the link, the second keeps everything.
    if (s.includes("Neuroglancer")) {
      const n = (asks.get(s) ?? 0) + 1;
      asks.set(s, n);
      return n === 1 ? "解释 Neuroglancer 的文字 ⟦0⟧。" : '解释 <a id="L0">Neuroglancer</a> 的文字 ⟦0⟧。';
    }
    if (s.includes("never keeps")) return "丢了链接。";
    if (s.includes("Introducing")) return "隆重推出 Sonnet 5.5。";
    return s.includes("twenty") ? "价格是二十美元。" : s.includes("ten") ? "价格是十美元。" : "译文";
  });
  return { id: "stub", choices: [{ message: { content: JSON.stringify({ t }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
const app = await buildApp();

// Discovered "later" than anything else in the test database, so a one-item run takes this article. The
// tag keeps the text unique: identical input would reuse an earlier run's paid answer.
const material = (price: string) =>
  upsertMaterial({
    sourceId: SOURCE, url: URL_, title: `Price update ${T}`, language: "en", bodyText: `The price is ${price} dollars (${T}).`,
    bodyHtml: `<p>The price is ${price} dollars (${T}).</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 600_000),
  });

async function detail(id: string) {
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body) as { body: { zh: string | null; original: string | null; complete: boolean } };
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test translate', 'rss', 'T1', 'editorial', true, false, '2100-01-01')`;
});
after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("Japanese bodies with kanji are translated with or without a language hint", async () => {
  // A newer Chinese original used to be skipped. Reconsidering old language skips must neither
  // send it to a paid provider nor let it take the single batch slot from Japanese behind it.
  const { articleId: chinese } = await upsertMaterial({ sourceId: SOURCE, url: `${URL_}-chinese`, title: '新的模型已发布',
    bodyText: '这是已经用中文写好的完整正文。', bodyHtml: '<p>这是已经用中文写好的完整正文。</p>',
    bodyStatus: 'ok', via: 'fetch', publishedAt: new Date(), discoveredAt: new Date(Date.now() + 600_000) });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES (${chinese},1,'rule','pass','ai-models','新的模型已发布','摘要','理由',90,true)`;
  await publishArticle(chinese, { releasedAt: new Date(Date.now() - 60_000) });
  await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome,reason)
    VALUES (${chinese},1,1,'skipped','no foreign-language body')`;
  for (const language of ["ja", null]) {
    const text = `新しい人工知能モデルを公開しました。日本語の性能が向上しています。${T}`;
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `${URL_}-japanese-${language}`, title: `新しい人工知能モデル ${T}`,
      language, bodyText: text, bodyHtml: `<p>${text}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
      VALUES (${articleId},1,'rule','pass','ai-models','发布新模型','摘要','理由',90,true)`;
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
    await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome,reason)
      VALUES (${articleId},1,1,'skipped','no foreign-language body')`;
    assert.equal((await translatePending({ limit: 1 })).done.find(row => row.articleId === articleId)?.status, "translated");
    assert.match((await detail(articleId)).body.zh ?? "", /译文/);
  }
  assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${chinese}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject LIKE ${`article:${chinese}@%`}`).length, 0);
  assert.equal((await sql`SELECT attempts FROM translation_attempts WHERE article_id=${chinese}`)[0]!.attempts, 1);
});

test("a presentation-only source update repairs original and translated bodies without new analysis or translation", async () => {
  const text = `The model introduces useful improvements ${T}. Read the documentation.`;
  const beforeHtml = `<p>The model introduces useful improvements ${T}.</p><p>Read <a href="https://example.com/old">the documentation</a>.</p>`;
  const afterHtml = `<div><p>The model introduces useful improvements ${T}.</p><figure><a href="https://example.com/chart"><img src="https://example.com/chart.png" alt="Chart"></a></figure><p>Read <a href="https://example.com/docs">the documentation</a>.</p></div>`;
  const material = { sourceId: SOURCE, url: `${URL_}-presentation`, title: `Display repair ${T}`, language: "en", bodyText: text, bodyHtml: beforeHtml,
    bodyStatus: "ok" as const, via: "fetch" as const, publishedAt: new Date() };
  const { articleId } = await upsertMaterial(material);
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','ai-models','模型改进','摘要','理由',90,true)`;
  await sql`UPDATE articles SET processing_state='analyzed',grouping_status='complete' WHERE id=${articleId}`;
  await sql`UPDATE sources SET syndicate_fulltext=true WHERE id=${SOURCE}`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  await sql`INSERT INTO translations(article_id,lang,revision,body_html,body_text,complete,origin)
    VALUES (${articleId},'zh',1,${'<p>模型有实用改进。</p><p>阅读<a href="https://example.com/old">文档</a>。</p>'},'模型有实用改进。阅读文档。',true,'model')`;
  const [before] = await sql`SELECT revision,content_hash,processing_state,grouping_status,timeline_at FROM articles WHERE id=${articleId}`;
  const [publication] = await sql`SELECT revision,selected,fact_id,story_id FROM publications WHERE article_id=${articleId}`;
  const calls = provider.hits();
  const oldFeed = await app.inject({ method: "GET", url: "/feed/full.xml" });
  const result = await upsertMaterial({ ...material, bodyHtml: afterHtml, media: [{ kind: "image", url: "https://example.com/chart.png" }] });
  assert.equal(result.revised, false);
  const body = (await detail(articleId)).body;
  const original = JSON.parse((await app.inject({ method: "GET", url: `/api/site/items/${articleId}/original` })).body).body.original;
  for (const html of [original, body.zh]) {
    assert.match(html ?? "", /chart\.png/);
    assert.match(html ?? "", /https:\/\/example.com\/docs/);
    assert.doesNotMatch(html ?? "", /https:\/\/example.com\/old/);
  }
  const markdown = await app.inject({ method: "GET", url: `/items/${articleId}/markdown` });
  assert.equal(markdown.statusCode, 200);
  assert.match(markdown.body, /chart\.png/);
  assert.match(markdown.body, /example.com\/docs/);
  const feed = await app.inject({ method: "GET", url: "/feed/full.xml", headers: { "if-none-match": oldFeed.headers.etag! } });
  assert.equal(feed.statusCode, 200, "the unchanged semantic revision still changes the full-feed ETag");
  const feedItem = feed.body.split("<item>").find(item => item.includes(`<guid isPermaLink="false">${articleId}</guid>`));
  assert.match(feedItem ?? "", /chart\.png/);
  assert.match(feedItem ?? "", /example.com\/docs/);
  assert.match(feedItem ?? "", /模型有实用改进/);
  assert.deepEqual({ ...(await sql`SELECT revision,content_hash,processing_state,grouping_status,timeline_at FROM articles WHERE id=${articleId}`)[0] }, { ...before });
  assert.deepEqual({ ...(await sql`SELECT revision,selected,fact_id,story_id FROM publications WHERE article_id=${articleId}`)[0] }, { ...publication });
  assert.equal(provider.hits(), calls);
  await sql`UPDATE articles SET updated_at='2020-01-01T00:00:00Z' WHERE id=${articleId}`;
  await upsertMaterial({ ...material, bodyHtml: afterHtml, media: [{ kind: "image", url: "https://example.com/chart.png" }] });
  assert.equal((await sql`SELECT updated_at FROM articles WHERE id=${articleId}`)[0]!.updated_at.toISOString(), '2020-01-01T00:00:00.000Z', "JSONB property order must not make identical media look changed on every collection");
  await sql`UPDATE sources SET syndicate_fulltext=false WHERE id=${SOURCE}`;
});

test("a layout refresh follows image identity when translated text moved its pictures", async () => {
  const text = `Compare charts A and B ${T}.`;
  const input = { sourceId: SOURCE, url: `${URL_}-reordered-media`, title: `Compare charts ${T}`, language: "en", bodyText: text,
    bodyHtml: `<p>Compare <img src="https://example.com/a.png"> charts <img src="https://example.com/b.png"> A and B ${T}.</p>`,
    bodyStatus: "ok" as const, via: "fetch" as const, publishedAt: new Date() };
  const { articleId } = await upsertMaterial(input);
  await sql`INSERT INTO translations(article_id,lang,revision,body_html,body_text,complete,origin)
    VALUES (${articleId},'zh',1,'<p>乙图<img src="https://example.com/b.png">与甲图<img src="https://example.com/a.png">。</p>','乙图与甲图。',true,'model')`;
  await upsertMaterial({ ...input, bodyHtml: input.bodyHtml.replace('/a.png', '/a-new.png').replace('/b.png', '/b-new.png') });
  const [tr] = await sql`SELECT body_html FROM translations WHERE article_id=${articleId}`;
  assert.equal(tr!.body_html, '<p>乙图<img src="https://example.com/b-new.png">与甲图<img src="https://example.com/a-new.png">。</p>');
});

test("a translation finishing during a layout refresh cannot restore the missing image", async () => {
  const text = `The price is ten dollars (layout-race-${T}).`;
  const input = { sourceId: SOURCE, url: `${URL_}-inflight-layout`, title: `Layout race ${T}`, language: "en", bodyText: text,
    bodyHtml: `<p>${text}</p>`, bodyStatus: "ok" as const, via: "fetch" as const, publishedAt: new Date() };
  const { articleId } = await upsertMaterial(input);
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','ai-models','模型价格','摘要','理由',90,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  asked = gate(); hold = gate();
  const translating = translateArticle(articleId);
  await Promise.race([asked.promise, translating.then(() => assert.fail("no translation request"))]);
  try {
    await upsertMaterial({ ...input, bodyHtml: `<p>${text}</p><figure><img src="https://example.com/restored.png"></figure>` });
  } finally { hold.open(); hold = null; }
  assert.equal((await translating).status, "translated");
  assert.match((await detail(articleId)).body.zh ?? "", /restored\.png/);
});

test("a text corrected while its translation was running is translated again, and the old translation is not shown", async () => {
  const { articleId: id } = await material("ten");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`价格更新-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });

  // The model is asked about revision 1; the source corrects the price before it answers.
  asked = gate();
  hold = gate();
  const running = translatePending({ limit: 1 });
  await Promise.race([asked.promise, running.then(() => assert.fail("the run ended without asking the model"))]);
  const revised = await material("twenty");
  assert.equal(revised.revised, true);
  hold.open();
  hold = null;
  await running;

  const [attempt] = await sql<{ revision: number; outcome: string }[]>`SELECT revision, outcome FROM translation_attempts WHERE article_id = ${id}`;
  assert.deepEqual({ ...attempt }, { revision: 1, outcome: "translated" }, "the attempt is booked on the revision translated");
  const stale = await detail(id);
  assert.equal(stale.body.zh, null, "a translation of the old wording is not shown");
  assert.ok(stale.body.original?.includes("twenty"));

  // The corrected material waits for its own analysis and identity decision before another paid
  // translation. Install that completed current-revision fixture, as the processing chain does.
  assert.equal((await sql`SELECT selected FROM publications WHERE article_id=${id}`)[0]!.selected, false);
  await sql`UPDATE analyses SET input_revision=2 WHERE article_id=${id}`;
  await sql`UPDATE articles SET processing_state='analyzed',grouping_status='complete',grouped_at=now() WHERE id=${id}`;
  await publishArticle(id);
  await translatePending({ limit: 1 });
  const [tr] = await sql<{ revision: number }[]>`SELECT revision FROM translations WHERE article_id = ${id}`;
  assert.equal(tr?.revision, 2, "the corrected text is translated on the next run");
  const current = await detail(id);
  assert.ok(current.body.zh?.includes("二十美元") && current.body.complete, "the page shows the translation of the corrected text");
});

test("links and images inside a paragraph survive the translation, or the paragraph stays in the original", async () => {
  // Google's fly-brain post lost its link to the Neuroglancer docs; a GPU price post lost two charts.
  const html = `<p>Explaining <a href="https://neuroglancer.dev/docs">Neuroglancer</a> in text ${T} <img src="https://example.com/chart-${T}.png" alt="B200 prices"></p>` +
    `<p>A paragraph the model <a href="https://example.com/kept">never keeps</a> whole ${T}.</p>`;
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `${URL_}-links`, title: `Links ${T}`, language: "en", bodyText: `Explaining Neuroglancer. ${T}`, bodyHtml: html,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 1_200_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`链接-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  await translatePending({ limit: 1 });
  const [tr] = await sql<{ body_html: string; complete: boolean }[]>`SELECT body_html, complete FROM translations WHERE article_id = ${id}`;
  assert.ok(tr!.body_html.includes('<a href="https://neuroglancer.dev/docs">Neuroglancer</a>'), tr!.body_html);
  assert.ok(tr!.body_html.includes(`chart-${T}.png`), "the chart stays");
  assert.ok(tr!.body_html.includes('<a href="https://example.com/kept">never keeps</a>'), "a paragraph that loses its link stays in the original");
  assert.equal(tr!.complete, false);
  const receipts = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE purpose = 'translate_body' AND subject LIKE ${`article:${id}@1#%`}`;
  assert.ok(receipts.length >= 2, "the initial batch and fallback/retry batches are retained");
  assert.ok(receipts.every((receipt) => receipt.status === "completed"), "every paid batch covered by the committed translation is completed");
});

test("the post a selected X post quotes is translated once and shown with the item", async () => {
  const tweetId = `7${Date.now()}`;
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `https://x.com/bcherny/status/8${Date.now()}`, title: `Sonnet ${T}`, language: "en", bodyText: "Try it!", bodyStatus: "ok",
    via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 1_800_000),
    xPost: { tweetId: `8${Date.now()}`, authorName: "Boris", handle: "bcherny", text: "Try it!", quoted: { authorName: "Anthropic", handle: "AnthropicAI", text: `Introducing Claude Sonnet 5.5 ${T}`, url: `https://x.com/AnthropicAI/status/${tweetId}` } },
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`引用-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  const run = await translatePending({ limit: 1 });
  assert.ok(run.quotes >= 1);
  const [q] = await sql<{ text_zh: string; origin: string }[]>`SELECT text_zh, origin FROM quote_translations WHERE tweet_id = ${tweetId}`;
  assert.deepEqual({ ...q }, { text_zh: "隆重推出 Sonnet 5.5。", origin: "model" });
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  const item = JSON.parse(res.body) as { x: { quoted: { text: string; translation: string | null } } };
  assert.deepEqual([item.x.quoted.text, item.x.quoted.translation], [`Introducing Claude Sonnet 5.5 ${T}`, "隆重推出 Sonnet 5.5。"]);
  await translatePending({ limit: 1 });
  const receipts = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE purpose = 'translate_quoted' AND subject = ${`quote:${tweetId}`}`;
  assert.equal(receipts.length, 1, "translated once");
  assert.equal(receipts[0]!.status, "completed");
});


test("an unusable X translation gets a bounded fresh attempt instead of terminal skipped", async () => {
  const marker = `alignment-x-${T}`;
  const text = `A new model release with practical improvements and detailed availability notes ${marker}. This post explains the new behavior and user-visible changes.`;
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `https://x.com/example/status/9${Date.now()}`, title: `Alignment X ${T}`, language: "en",
    bodyText: text, bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 3_600_000),
    xPost: { tweetId: `9${Date.now()}`, authorName: "Test", handle: "example", text },
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`校验-X-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  misalignedAnswers.set(marker, 1);
  const before = provider.hits();
  const first = await translatePending({ limit: 1 });
  assert.equal(first.done.find((r) => r.articleId === id)?.status, "failed");
  const [failed] = await sql<{ attempts: number; outcome: string; reason: string }[]>`SELECT attempts, outcome, reason FROM translation_attempts WHERE article_id = ${id}`;
  assert.deepEqual({ ...failed }, { attempts: 1, outcome: "failed", reason: "translation did not line up" });
  assert.equal(provider.hits() - before, 1, "the failed model answer was saved once");

  const second = await translatePending({ limit: 1 });
  assert.equal(second.done.find((r) => r.articleId === id)?.status, "translated");
  assert.equal(provider.hits() - before, 2, "the second attempt paid for a new answer");
  const [attempt] = await sql<{ attempts: number; outcome: string }[]>`SELECT attempts, outcome FROM translation_attempts WHERE article_id = ${id}`;
  assert.deepEqual({ ...attempt }, { attempts: 2, outcome: "translated" });
  const receipts = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM receipts WHERE purpose = 'translate_body' AND subject LIKE ${`article:${id}@1#%`}`;
  assert.deepEqual(receipts.map((r) => ({ ...r })), [{ status: "completed", attempts: 2 }], "the unusable answer was rejected and its request paid again");
  assert.equal((await detail(id)).body.complete, true);
});

test("fully unusable body translations stop after three recorded attempts", async () => {
  const marker = `alignment-body-${T}`;
  const text = `One complete English paragraph ${marker} that requires a Chinese translation.`;
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `${URL_}-alignment`, title: `Alignment body ${T}`, language: "en",
    bodyText: text, bodyHtml: `<p>${text}</p>`, bodyStatus: "ok", via: "fetch",
    publishedAt: new Date(), discoveredAt: new Date(Date.now() + 7_200_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`校验正文-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  misalignedAnswers.set(marker, 10);
  const before = provider.hits();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const run = await translatePending({ limit: 1 });
    assert.equal(run.done.find((r) => r.articleId === id)?.status, "failed");
    const [saved] = await sql<{ attempts: number; outcome: string }[]>`SELECT attempts, outcome FROM translation_attempts WHERE article_id = ${id}`;
    assert.deepEqual({ ...saved }, { attempts: attempt, outcome: "failed" });
  }
  assert.equal(provider.hits() - before, 6, "one initial batch and one fallback per bounded attempt");
  const exhausted = await translatePending({ limit: 1 });
  assert.equal(exhausted.done.some((r) => r.articleId === id), false, "the fourth automatic attempt is blocked");
  assert.equal(provider.hits() - before, 6);
  assert.equal((await sql`SELECT 1 FROM translations WHERE article_id = ${id}`).length, 0, "no invalid translation is published");
});

test("a received alignment retry survives a failed translation commit without paying again", async () => {
  const marker = `alignment-recovery-${T}`;
  const post = `This detailed English announcement ${marker} describes a new public release and its availability. The main changes are supported by documented examples and clear usage notes.`;
  const tweetId = `9${Date.now()}`;
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `https://x.com/example/status/${tweetId}`, title: `Recovery ${T}`, language: "en",
    bodyText: post, bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 10_800_000),
    xPost: { tweetId, authorName: "Test", handle: "example", text: post },
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`恢复测试-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  misalignedAnswers.set(marker, 1);
  const before = provider.hits();
  const first = await translatePending({ limit: 1 });
  assert.equal(first.done.find((r) => r.articleId === id)?.status, "failed");
  const [one] = await sql<{ attempts: number; outcome: string }[]>`SELECT attempts, outcome FROM translation_attempts WHERE article_id = ${id}`;
  assert.deepEqual({ ...one }, { attempts: 1, outcome: "failed" });

  await sql.unsafe(`CREATE FUNCTION fail_translation_receipt() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN
    IF NEW.status = 'completed' AND NEW.purpose = 'translate_body' THEN RAISE EXCEPTION 'receipt commit interrupted'; END IF;
    RETURN NEW; END $body$`);
  await sql`CREATE TRIGGER fail_translation_receipt BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION fail_translation_receipt()`;
  try {
    const second = await translatePending({ limit: 1 });
    assert.equal(second.done.some((r) => r.articleId === id), true, "the paid response arrived before the storage failure");
    const [failed] = await sql<{ attempts: number; outcome: string; reason: string }[]>`
      SELECT attempts, outcome, reason FROM translation_attempts WHERE article_id = ${id}`;
    assert.equal(failed!.attempts, 2);
    assert.equal(failed!.outcome, "failed");
    assert.match(failed!.reason, /receipt commit interrupted/);
    const [answer] = await sql<{ status: string }[]>`
      SELECT status FROM receipts WHERE purpose = 'translate_body' AND subject = ${`article:${id}@1#0`} ORDER BY id DESC LIMIT 1`;
    assert.equal(answer!.status, "received", "the valid paid answer is saved even though the business write rolled back");
    assert.equal(provider.hits() - before, 2);
    assert.equal((await sql`SELECT 1 FROM translations WHERE article_id = ${id}`).length, 0);
  } finally {
    await sql`DROP TRIGGER fail_translation_receipt ON receipts`;
    await sql`DROP FUNCTION fail_translation_receipt()`;
  }

  const recovered = await translatePending({ limit: 1 });
  assert.equal(recovered.done.find((r) => r.articleId === id)?.status, "translated");
  assert.equal(provider.hits() - before, 2, "recovery reuses the second already paid answer");
  const [attempt] = await sql<{ attempts: number; outcome: string }[]>`SELECT attempts, outcome FROM translation_attempts WHERE article_id = ${id}`;
  assert.deepEqual({ ...attempt }, { attempts: 3, outcome: "translated" });
  assert.equal((await detail(id)).body.complete, true);
});

test("an overloaded provider and a timed-out request use up no attempts: after the release the text is translated", async () => {
  // A timed-out batch leaves its receipt unknown; the next two runs met that receipt again and spent all three
  // attempts within ten minutes, so the automatic release half an hour later came too late and nothing alerted.
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `${URL_}-timeout`, title: `Timeout ${T}`, language: "en",
    bodyText: `A paragraph whose answer is lost ${T}.`, bodyHtml: `<p>A paragraph whose answer is lost ${T}.</p>`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 14_400_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${`超时-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });

  // First overloaded (503, nothing billed), then the connection is lost after the request went out.
  let trouble: "overloaded" | "lost" = "overloaded";
  const troubled = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => (trouble === "overloaded" ? res.writeHead(503).end('{"error":"overloaded"}') : req.socket.destroy()));
  });
  await new Promise<void>((resolve) => troubled.listen(0, "127.0.0.1", resolve));
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(troubled.address() as { port: number }).port}/v1`;
  try {
    await translatePending({ limit: 1 });
    trouble = "lost";
    for (let run = 0; run < 3; run++) await translatePending({ limit: 1 }); // every five minutes
  } finally {
    process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
    await new Promise((resolve) => troubled.close(resolve));
  }
  const receipts = () => sql<{ id: number; status: string }[]>`
    SELECT id, status FROM receipts WHERE purpose = 'translate_body' AND subject LIKE ${`article:${id}@1#%`}`;
  assert.deepEqual((await receipts()).map((r) => r.status), ["unknown"]);
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id = ${id}`).length, 0, "no attempt was used up");

  // ops.recover releases the unknown receipt after half an hour; the next run translates.
  await sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE id = ${(await receipts())[0]!.id}`;
  assert.equal((await autoReleaseUnknownReceipts()).released, 1);
  const run = await translatePending({ limit: 1 });
  assert.equal(run.done.find((r) => r.articleId === id)?.status, "translated");
  const [attempt] = await sql<{ attempts: number; outcome: string }[]>`SELECT attempts, outcome FROM translation_attempts WHERE article_id = ${id}`;
  assert.deepEqual({ ...attempt }, { attempts: 1, outcome: "translated" });
  assert.equal((await detail(id)).body.complete, true);
});

// Account limits affect the service, not the text: several scheduled runs must not permanently
// exclude the article, and restoring access must let the next existing run finish it.
test("account 429 pauses translation without spending the article attempts", async () => {
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `${URL_}-account`, title: `Account limit ${T}`, language: "en",
    bodyText: `A paragraph waiting for account access ${T}.`, bodyHtml: `<p>A paragraph waiting for account access ${T}.</p>`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now()+20_000_000),
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES(${id},1,'rule','pass','ai-models','账户等待','摘要','理由',90,true)`;
  await publishArticle(id,{releasedAt:new Date(Date.now()-60_000)});
  const original = process.env.TRANSLATE_MODEL;
  const denied=await stub(()=>new Reply(429,{error:{code:"1113",message:"account unavailable"}}));
  pointModels(denied.url,["glm-5.3-flash"]);
  process.env.TRANSLATE_MODEL="glm-5.3-flash";
  try {
    for (let run=0;run<3;run++) await translatePending({limit:1});
    assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${id}`).length,0);
    // The account refusal paused the service for a cooldown; access is restored here, and the cooldown
    // has to pass before the same service is called again.
    await sql`DELETE FROM settings WHERE key='provider.stop.zhipu:glm-5.3-flash'`;
    pointModels(provider.url,["glm-5.3-flash"]);
    const restored=await translatePending({limit:1});
    assert.equal(restored.done.find(r=>r.articleId===id)?.status,"translated");
    assert.equal((await detail(id)).body.complete,true);
  } finally {
    if(original===undefined) delete process.env.TRANSLATE_MODEL; else process.env.TRANSLATE_MODEL=original;
    await denied.close();
  }
});

test("saved X long articles neither buy unused introduction translations nor occupy the translation batch", async () => {
  const source = `${SOURCE}-long-article`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext,next_fetch_at)
    VALUES(${source},'Saved long article','x_search','T1','editorial',true,true,'2100-01-01')`;
  const intro = `This introduction is long enough to be translated, but its translation would omit the already saved complete article. ${T}`;
  const { articleId: long } = await upsertMaterial({sourceId: source, url: `https://x.com/fixture/status/${T}`, title: intro,
    language: 'en', bodyText: intro, bodyStatus: 'ok', via: 'fetch', publishedAt: new Date(), discoveredAt: new Date(Date.now()+30_000_000),
    xPost: {tweetId: T, authorName: 'Fixture', handle: 'fixture', text: intro}});
  await sql`UPDATE articles SET x_article=${sql.json({title:'Saved long article',text:'The complete article is already stored.'})} WHERE id=${long}`;
  const { articleId: regular } = await upsertMaterial({sourceId: SOURCE, url: `${URL_}-behind-long-article`, title: `Regular article ${T}`,
    language: 'en', bodyText: `The price is ten dollars ${T}.`, bodyHtml: `<p>The price is ten dollars ${T}.</p>`,
    bodyStatus: 'ok', via: 'fetch', publishedAt: new Date(), discoveredAt: new Date(Date.now()+29_000_000)});
  for (const id of [long, regular]) {
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
      VALUES(${id},1,'rule','pass','ai-models','保存正文','摘要','理由',90,true)`;
    await publishArticle(id,{releasedAt:new Date(Date.now()-60_000)});
  }
  const calls = provider.hits();
  assert.equal((await translateArticle(long)).status,'skipped');
  assert.equal(provider.hits(),calls,'a direct request must not pay for a translation readers cannot see');
  const run = await translatePending({limit:1});
  assert.equal(run.done.find(r=>r.articleId===regular)?.status,'translated','skip the long article before applying the batch limit');
  assert.ok(!run.done.some(r=>r.articleId===long));
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject LIKE ${`article:${long}@%`}`).length,0);
  assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${long}`).length,0);
});
