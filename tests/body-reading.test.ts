import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { bodyBlocks, cleanTranscription } from "@aihot/backend/content/blocks";
import { readable } from "@aihot/backend/content/extract";
import { readArticle, readingImages } from "@aihot/backend/content/reading";
import { upsertMaterial, contentHash } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { publishArticle } from "@aihot/backend/publication/publish";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { exportMarkdown, loadItemDetail } from "@aihot/backend/publication/detail";
import { publishedReadingImage } from "@aihot/backend/publication/reading";
import { requestReading, correctReading } from "@aihot/backend/admin/readings";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { switchModel } from "@aihot/backend/admin/models";
import { processReading } from "@aihot/backend/jobs/reading";
import { fetchReadingImage } from "@aihot/backend/media/reading-images";

const T = tag();
const temp = await mkdtemp(path.join(os.tmpdir(), "body-reading-test-"));
config.dataDir = temp;
config.allowPrivateNetworkFetch = true;
config.modelCallsEnabled = true; // All image and model requests below use local HTTP stubs.
config.egressProxyUrl = null;
let price = 4200;
const picture = (color: string) => sharp(Buffer.from(`<svg width="1000" height="600"><rect width="1000" height="600" fill="${color}"/><text x="50" y="100" font-size="48">TEST API ${price} USD/M tokens 2026-09-28</text></svg>`)).png().toBuffer();
let bytes = await picture("white");
let missing = true;
const downloads: string[] = [];
const images = http.createServer((req, res) => {
  downloads.push(req.url!);
  res.writeHead(unavailable ? 503 : missing && req.url?.includes("missing") ? 404 : 200, { "content-type": "image/png" });
  res.end(bytes);
});
await new Promise<void>((resolve) => images.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(images.address() as { port: number }).port}`;
const sent: Array<{ system: string; user: any }> = [];
let malformed = false;
let truncated = false;
let unavailable = false;
let uncertain = false;
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body);
  const system = body.messages[0].role === "system" ? body.messages[0].content : "";
  const user = body.messages.at(-1).content;
  sent.push({ system, user });
  let answer: unknown;
  if (system.includes("keepBlockIds")) {
    answer = { confirmed: true, keepBlockIds: JSON.parse(user).blocks.map((b: any) => b.id), reason: "公告正文" };
  } else if (system.includes("逐段转录")) {
    if (hold) { const h = hold; hold = null; h.entered.open(); await h.release.promise; }
    const contexts = user.filter((p: any) => p.type === "text" && p.text.startsWith("{")).map((p: any) => JSON.parse(p.text)).filter((p: any) => p.imageId);
    const values = contexts.map((c: any) => ({ imageId: c.imageId, role: c.alt === "decorative" ? "decorative" : "table",
      status: c.alt === "decorative" ? "ignored" : uncertain ? "unreadable" : "read", reason: "本地测试桩",
      markdown: c.alt === "decorative" ? "" : `OpenAI API 使用价格公告。\n\n| 价格 | 单位 | 执行日期 |\n| --- | --- | --- |\n| ${price} | 美元/百万 token | 2026-09-28 |\n\n以上为测试数据，含税，按公告执行。`,
      uncertainties: uncertain ? ["数字无法确认"] : [], regions: [{ tile: 0, text: "测试价格表" }] }));
    answer = { images: malformed ? [...values, values[0]] : values };
  } else if (system.includes("宽召回")) answer = { label: "PASS", reason: "API价格公告" };
  else if (system.includes("事件注意力评分器")) answer = { attentionScore: 21 };
  else if (system.includes("资料结构化助手")) answer = { category: "ai-models", tags: ["模型"], subjects: ["openai"], fact: { title: "API使用价格公告", subject: "OpenAI", action: "公布", object: "API价格", occurredAt: "2026-09-28" } };
  else answer = `title_zh: OpenAI公布API使用价格\nsummary_zh: OpenAI公布API使用价格${price}美元/百万 token，执行日期为2026年9月28日，含税口径以公告为准。`;
  return { choices: [{ finish_reason: truncated ? "length" : "stop", message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) } }] };
});
Object.assign(process.env, { BODY_READING_MODE: "active", BODY_READING_MODEL: "default", LLM_VISION: "true", LLM_MODEL: "reading-test", LLM_API_KEY: "test-key", LLM_BASE_URL: `${provider.url}/v1` });
for (const step of ["PREFILTER", "SCORE", "STRUCTURE", "UNDERSTAND", "SUMMARIZE"]) process.env[`${step}_MODEL`] = "default";
await sql`INSERT INTO sources (id, name, kind, tier, site_fulltext, syndicate_fulltext, config) VALUES (${T}, '测试模型公告', 'web_list', 'T1', true, true, ${sql.json({ body: { selector: ".article" } })})`;

after(async () => {
  await provider.close();
  await new Promise<void>((resolve) => images.close(() => resolve()));
  await stopBoss();
  await closeDb();
  await rm(temp, { recursive: true, force: true });
});

let n = 0;
async function article(paths: string[], text = "") {
  return (await upsertMaterial({ sourceId: T, title: `API价格公告 ${++n}`, url: `https://example.org/${T}/${n}`,
    bodyText: text, bodyHtml: `${text ? `<p>${text}</p>` : ""}${paths.map((p) => `<p><img src="${base}/${p}" alt="${p.startsWith("logo") ? "decorative" : "price"}"></p>`).join("")}`,
    bodyStatus: "ok", language: "zh", via: "fetch" })).articleId;
}

test("ordered blocks preserve caption, context and ownership; transcription cannot inject media", () => {
  const blocks = bodyBlocks('<nav>首页</nav><h2>华北价格</h2><p>价格按含税口径。</p><figure><img src="/price.png"><figcaption>9月28日价格表</figcaption></figure><p>执行至下一次通知。</p>', "https://example.org");
  const image = blocks.find((b) => b.kind === "image")!;
  assert.equal(image.url, "https://example.org/price.png");
  assert.match(image.before!, /含税/);
  assert.match(image.after!, /执行/);
  assert.equal(image.caption, "9月28日价格表");
  assert.equal(image.section, "华北价格");
  assert.ok(blocks.every((b) => !b.text.includes("首页")));
  assert.doesNotMatch(cleanTranscription('文字 ![x](http://127.0.0.1/secret) <script>bad()</script> [链接](https://evil.example)'), /127\.0|evil\.example|script/);
  assert.throws(() => bodyBlocks('<img class="same" src="https://example.org/x.png">', 'https://example.org', { images: { keepSelectors: [".same"], removeSelectors: [".same"] } }), /同时匹配/);
});

test("image-only body reads beyond the fourth image, excludes decoration and shares evidence with all analysis steps", async () => {
  const id = await article(["logo.png", "a.png", "b.png", "c.png", "d.png", "last-price.png"]);
  const { reading, activated } = await readArticle(id);
  assert.equal(activated, true);
  assert.equal(reading?.quality, "complete");
  assert.equal(reading?.coverage.read, 5);
  assert.equal(reading?.coverage.ignored, 1);
  assert.ok(downloads.includes("/last-price.png"));
  assert.match(reading!.body_markdown!, /4200.*美元\/百万 token/);
  assert.doesNotMatch(reading!.body_markdown!, /logo\.png/);
  const start = sent.length;
  const analysis = await analyzeArticle(id);
  assert.match(analysis!.output!.summaryZh!, /OpenAI.*4200/);
  assert.equal(sent.length - start, 5);
  assert.ok(sent.slice(start).every((s) => typeof s.user === "string"), "later stages do not re-send images");
  assert.ok(sent.slice(start).every((s) => s.user.includes("4200")), "all stages read the same transcribed value");
  await publishArticle(id);
  const detail = await loadItemDetail(id);
  assert.equal(detail.kind, "found");
  if (detail.kind === "found") assert.match(detail.detail.body!.zh!, /4200/);
  const md = await exportMarkdown(id);
  assert.match(md!.body, /图片表格/);
  assert.match(md!.body, /body-images\/[a-f0-9]{64}/);
  const first = (await readingImages(reading!.id)).find((i) => i.status === "read")!;
  assert.ok(await publishedReadingImage(id, first.asset_hash!));
  await sql`UPDATE sources SET site_fulltext = false WHERE id = ${T}`;
  await publishArticle(id);
  assert.doesNotMatch((await exportMarkdown(id))!.body, /图片表格/);
  assert.equal(await publishedReadingImage(id, first.asset_hash!), null);
  await sql`UPDATE sources SET site_fulltext = true WHERE id = ${T}`;
});

test("failed first four images never hide a readable fifth; partial results do not activate and retry only missing images", async () => {
  missing = true;
  const id = await article(["missing1.png", "missing2.png", "missing3.png", "missing4.png", "fifth.png"]);
  const first = await readArticle(id);
  assert.equal(first.activated, false);
  assert.equal(first.reading?.quality, "partial");
  assert.equal(first.reading?.coverage.read, 1);
  const start = downloads.length;
  missing = false;
  const again = await readArticle(id, { requestKey: "retry-images-once" });
  assert.equal(again.reading?.id, first.reading?.id);
  assert.equal(again.activated, true);
  assert.ok(downloads.slice(start).every((url) => !url.includes("fifth")), "settled image is not downloaded again");
});

test("image changes revise material and retain the released snapshot until its replacement is accepted", async () => {
  const id = await article(["old.png"]);
  await readArticle(id); await analyzeArticle(id); await publishArticle(id);
  const before = (await exportMarkdown(id))!.body;
  const [a] = await sql`SELECT * FROM articles WHERE id = ${id}`;
  const update = await upsertMaterial({ sourceId: T, title: a!.title, url: a!.url, bodyText: "", bodyHtml: `<img src="${base}/missing-new.png">`, bodyStatus: "ok", via: "fetch" });
  assert.equal(update.revised, true);
  missing = true;
  const bad = await readArticle(id);
  assert.equal(bad.activated, false);
  await publishArticle(id);
  assert.equal((await exportMarkdown(id))!.body, before);
  assert.notEqual(contentHash({ title: "图片", bodyHtml: '<img src="https://example.org/a.png">' }), contentHash({ title: "图片", bodyHtml: '<img src="https://example.org/b.png">' }));
  missing = false;
});

test("a changed image at the same URL gets new bytes; request IDs prevent double generation bumps", async () => {
  const id = await article(["mutable.png"]);
  const old = (await readArticle(id)).reading!;
  const oldImage = (await readingImages(old.id))[0]!;
  price = 4400; bytes = await picture("#eeeeff");
  const requestId = `mutable-${T}`;
  const queued = await requestReading(id, requestId, "test");
  assert.deepEqual(await requestReading(id, requestId, "test"), queued);
  const [state] = await sql`SELECT reading_generation FROM articles WHERE id = ${id}`;
  assert.equal(state!.reading_generation, 1);
  const fresh = (await readArticle(id, { requestKey: requestId, silent: true })).reading!;
  assert.notEqual((await readingImages(fresh.id))[0]!.asset_hash, oldImage.asset_hash);
  assert.match(fresh.body_text!, /4400/);
  assert.match(old.body_text!, /4200/);
});

test("shadow requests never invalidate accepted evidence or change publication", async () => {
  const id = await article(["shadow.png"]);
  await readArticle(id); await analyzeArticle(id); await publishArticle(id);
  const [before] = await sql`SELECT accepted_reading_id, reading_generation, processing_state FROM articles WHERE id = ${id}`;
  const md = (await exportMarkdown(id))!.body;
  process.env.BODY_READING_MODE = "shadow";
  const key = `shadow-${T}`;
  await requestReading(id, key, "test");
  const result = await readArticle(id, { requestKey: key });
  assert.equal(result.activated, false);
  const [after] = await sql`SELECT accepted_reading_id, reading_generation, processing_state FROM articles WHERE id = ${id}`;
  assert.deepEqual(after, before);
  assert.equal((await exportMarkdown(id))!.body, md);
  process.env.BODY_READING_MODE = "active";
});

test("reading completed for an older revision cannot activate", async () => {
  const id = await article(["slow.png"]);
  const h = { entered: gate(), release: gate() };
  hold = h;
  const running = readArticle(id);
  await h.entered.promise;
  await sql`UPDATE articles SET revision = revision + 1 WHERE id = ${id}`;
  h.release.open();
  const result = await running;
  assert.equal(result.stale, true);
  assert.equal(result.activated, false);
  const [a] = await sql`SELECT accepted_reading_id FROM articles WHERE id = ${id}`;
  assert.equal(a!.accepted_reading_id, null);
});

test("coverage validation rejects duplicate image IDs and uncertain values do not become full evidence", async () => {
  const id = await article(["invalid.png"]);
  malformed = true;
  await assert.rejects(readArticle(id), /未完整覆盖|unusable output/);
  malformed = false;
  uncertain = true;
  const incomplete = await readArticle(id);
  assert.equal(incomplete.activated, false);
  assert.equal(incomplete.reading?.quality, "partial");
  assert.doesNotMatch(incomplete.reading!.body_text!, /4400/);
  uncertain = false;
});

test("manual corrections are append-only, version checked and idempotent", async () => {
  const id = await article(["correct.png"]);
  const old = (await readArticle(id)).reading!;
  const input = { readingId: old.id, generation: 0, markdown: old.body_markdown!.replaceAll("4400", "4300"), reason: "测试：按原图更正价格" };
  const key = `correction-${T}`;
  const corrected = await correctReading(id, input, key, "test");
  assert.deepEqual(await correctReading(id, input, key, "test"), corrected);
  assert.match((await loadAnalyzeInput(id))!.bodyText!, /4300/);
  const [unchanged] = await sql`SELECT body_markdown FROM article_readings WHERE id = ${old.id}`;
  assert.match(unchanged!.body_markdown, /4400/);
  await assert.rejects(correctReading(id, input, `another-${T}`, "test"), /已更新/);
});

test("admin can choose vision for text tasks; reading still requires vision, and model safety valve blocks jobs", async () => {
  await switchModel("summarize", "default", "local test", "test");
  await assert.rejects(switchModel("bodyReading", "deepseek-flash", "local test", "test"), /vision/);
  const hits = provider.hits();
  config.modelCallsEnabled = false;
  assert.equal((await processReading("does-not-matter")).state, "disabled");
  assert.equal(provider.hits(), hits);
  config.modelCallsEnabled = true;
});

test("reading rejects unbounded image dimensions without trusting display cache", async () => {
  const long = await sharp({ create: { width: 1000, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
  const saved = bytes;
  bytes = long;
  const asset = await fetchReadingImage(`${base}/long.png`);
  assert.equal(asset.tiles.length, 3);
  assert.equal(asset.tiles[1]!.region.top, 1680);
  bytes = saved;
});


test("shadow jobs stay isolated after changing deployment mode to active", async () => {
  const id = await article(["mode-flip.png"]);
  const [before] = await sql`SELECT accepted_reading_id, reading_generation, processing_state FROM articles WHERE id = ${id}`;
  const result = await processReading(id, { mode: "shadow", requestKey: `shadow-flip-${T}` });
  assert.equal(result.state, "shadow");
  const [after] = await sql`SELECT accepted_reading_id, reading_generation, processing_state FROM articles WHERE id = ${id}`;
  assert.deepEqual(after, before);
  const [r] = await sql`SELECT mode FROM article_readings WHERE article_id = ${id}`;
  assert.equal(r!.mode, "shadow");
});

test("plain text needs no reading model request and inline image order is retained", async () => {
  const id = await article([], "模型服务更新，报价单位为美元每百万 token，详情见公告。".repeat(15));
  const hits = provider.hits();
  assert.equal((await readArticle(id)).activated, true);
  assert.equal(provider.hits(), hits);
  const blocks = bodyBlocks('<p>前文<img src="https://example.org/a.png">后文</p><ul><li>甲</li><li>乙</li></ul>', "https://example.org");
  assert.deepEqual(blocks.slice(0, 3).map((b) => b.kind), ["text", "image", "text"]);
  assert.equal(blocks[1]!.before, "前文");
  assert.match(blocks[1]!.after!, /后文/);
  assert.match(blocks[3]!.html, /<ul>/);
});

test("truncated model output and late generations never become accepted evidence", async () => {
  const id = await article(["truncated.png"]);
  truncated = true;
  await assert.rejects(readArticle(id), /truncated|unusable output/);
  truncated = false;
  const [a] = await sql`SELECT accepted_reading_id FROM articles WHERE id = ${id}`;
  assert.equal(a!.accepted_reading_id, null);
  const h = { entered: gate(), release: gate() };
  hold = h;
  const running = readArticle(id, { requestKey: `not-truncated-${T}` });
  await h.entered.promise;
  await requestReading(id, `new-generation-${T}`, "test");
  h.release.open();
  assert.equal((await running).stale, true);
});

test("temporary download errors wait for retry without publishing partial evidence", async () => {
  const id = await article(["temporarily-down.png"]);
  unavailable = true;
  const result = await processReading(id);
  unavailable = false;
  assert.equal(result.state, "retrying");
  const [a] = await sql`SELECT accepted_reading_id, processing_retry_at FROM articles WHERE id = ${id}`;
  assert.equal(a!.accepted_reading_id, null);
  assert.ok(a!.processing_retry_at);
  assert.equal((await readArticle(id)).activated, true);
});

test("a manual correction cannot retain an image without a snapshot or modify shadow publication", async () => {
  missing = true;
  const id = await article(["missing-manual.png"]);
  const old = (await readArticle(id)).reading!;
  const input = { readingId: old.id, generation: 0, markdown: old.body_markdown! + "\n\n人工核实的正文。", reason: "按原文核实" };
  await assert.rejects(correctReading(id, input, `missing-correction-${T}`, "test"), /缺少可核对的快照/);
  process.env.BODY_READING_MODE = "shadow";
  await assert.rejects(correctReading(id, { ...input, markdown: "已核实正文" }, `shadow-correction-${T}`, "test"), /对照模式/);
  process.env.BODY_READING_MODE = "active";
  missing = false;
});


test("repeated publication cannot expose an unaccepted raw image body", async () => {
  const id = await article(["not-read.png"]);
  await publishArticle(id); await publishArticle(id);
  const [p] = await sql`SELECT body_mode, reading_id FROM publications WHERE article_id = ${id}`;
  assert.equal(p!.body_mode, "summary");
  assert.equal(p!.reading_id, null);
});


test("unknown reading receipts block manual duplicates and resume the reading stage after release", async () => {
  const id = await article(["unknown-receipt.png"]);
  const r = (await readArticle(id)).reading!;
  const receipt = r.receipt_ids.at(-1)!;
  await sql`UPDATE receipts SET status = 'unknown' WHERE id = ${receipt}`;
  await sql`UPDATE articles SET processing_state = 'failed' WHERE id = ${id}`;
  await assert.rejects(requestReading(id, `unknown-retry-${T}`, "test"), /付费结果尚未确认/);
  const result = await releaseReceipt(receipt, { billed: false, note: "本地测试回执，无外部请求" }, "test");
  assert.equal(result!.requeued, true);
  const [job] = await sql`SELECT data FROM pgboss.job WHERE name = 'content.read-body' AND data->>'articleId' = ${id} ORDER BY created_on DESC LIMIT 1`;
  assert.equal(job!.data.mode, "active");
});


test("X post and quote image contexts stay separate and full RSS uses the same reading", async () => {
  const xPost = { tweetId: `${Date.now()}`, authorName: "原作者", handle: "main_author", text: "原帖的价格观点。",
    media: [{ kind: "image" as const, url: `${base}/main-author.png` }],
    quoted: { authorName: "引用作者", handle: "quote_author", text: "被引用公告的执行日期与原帖观点不同。", url: "https://x.com/quote_author/status/1234567",
      media: [{ kind: "image" as const, url: `${base}/quote-author.png` }] } };
  const { articleId: id } = await upsertMaterial({ sourceId: T, title: "API价格图文引用", url: `https://x.com/main_author/status/${xPost.tweetId}`,
    bodyText: xPost.text, xPost, language: "zh", bodyStatus: "ok", via: "fetch" });
  const start = sent.length;
  const r = (await readArticle(id)).reading!;
  const contexts = sent.slice(start).flatMap(s => Array.isArray(s.user) ? s.user.filter((p: any) => p.type === "text" && p.text.startsWith("{")).map((p: any) => JSON.parse(p.text)) : []).filter((x: any) => x.imageId);
  assert.equal(contexts.find((c: any) => c.owner === "post").before.includes("被引用"), false);
  assert.match(contexts.find((c: any) => c.owner === "quote-quote_author").before, /被引用公告/);
  assert.match(r.body_text!, /引用 @quote_author/);
  await analyzeArticle(id);
  await sql`UPDATE analyses SET selected = true, score = 90 WHERE article_id = ${id}`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60000) });
  const detail = await loadItemDetail(id);
  assert.equal(detail.kind, "found");
  if (detail.kind === "found") { assert.equal(detail.detail.x!.media.length, 0); assert.equal(detail.detail.x!.quoted, null); }
  const rss = await itemFeed("selected-full", null);
  assert.match(rss, /图片表格/);
  assert.match(rss, /body-images/);
  const changedQuote = { ...xPost, quoted: { ...xPost.quoted, text: "被引用公告已修订执行日期。" } };
  const changed = await upsertMaterial({ sourceId: T, title: "API价格图文引用", url: `https://x.com/main_author/status/${xPost.tweetId}`,
    bodyText: xPost.text, xPost: changedQuote, language: "zh", bodyStatus: "ok", via: "fetch" });
  assert.equal(changed.revised, true, "quoted context changes invalidate the reading");
});


test("extraction preserves the selected container for ancestor image rules", () => {
  const rules = { selector: ".article-content", images: { keepSelectors: [".article-content img"] } };
  const extracted = readable('<nav>首页</nav><div class="article-content"><img src="https://example.org/notice.png"></div>', "https://example.org", rules)!;
  assert.equal(extracted.confirmed, true);
  assert.equal(bodyBlocks(extracted.snapshotHtml, "https://example.org", rules)[0]!.rule, "keep");
});


test("a late reading failure cannot mark a newer generation failed", async () => {
  const id = await article(["late-failure.png"]);
  const h = { entered: gate(), release: gate() };
  hold = h; malformed = true;
  const running = processReading(id);
  await h.entered.promise;
  await requestReading(id, `newer-than-failure-${T}`, "test");
  h.release.open();
  assert.equal((await running).state, "stale");
  malformed = false;
  const [a] = await sql`SELECT processing_state, processing_attempts, reading_generation FROM articles WHERE id = ${id}`;
  assert.equal(a!.processing_state, "new");
  assert.equal(a!.processing_attempts, 0);
  assert.equal(a!.reading_generation, 1);
});


test("published image snapshots respect the release gate, withdrawal and current source permissions", async () => {
  const id = await article(["permission.png"]);
  const r = (await readArticle(id)).reading!;
  await analyzeArticle(id);
  await sql`UPDATE analyses SET selected = true, score = 90 WHERE article_id = ${id}`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60000) });
  const hash = (await readingImages(r.id))[0]!.asset_hash!;
  assert.ok(await publishedReadingImage(id, hash));
  await sql`UPDATE publications SET visible_after = now() + interval '1 hour' WHERE article_id = ${id}`;
  assert.equal(await publishedReadingImage(id, hash), null);
  await sql`UPDATE publications SET visible_after = now() - interval '1 hour', visibility = 'withdrawn' WHERE article_id = ${id}`;
  assert.equal(await publishedReadingImage(id, hash), null);
  await sql`UPDATE publications SET visibility = 'public' WHERE article_id = ${id}`;
  await sql`UPDATE sources SET site_fulltext = false WHERE id = ${T}`;
  try { assert.equal(await publishedReadingImage(id, hash), null); }
  finally { await sql`UPDATE sources SET site_fulltext = true WHERE id = ${T}`; }
  assert.ok(await publishedReadingImage(id, hash));
});
