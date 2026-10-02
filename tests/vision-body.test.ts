import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { loadAnalyzeInput, runAnalysis } from "@aihot/backend/editorial/analyze";

const T = tag();
const picture = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "white" } }).png().toBuffer();
let reads = 0;
const images = http.createServer((req, res) => {
  reads++;
  res.writeHead(req.url?.includes("missing") ? 404 : 200, { "content-type": "image/png" });
  res.end(picture);
});
await new Promise<void>((resolve) => images.listen(0, "127.0.0.1", resolve));
const imageBase = `http://127.0.0.1:${(images.address() as { port: number }).port}`;
const requests: Array<{ system: string; content: any }> = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const system = body.messages[0].role === "system" ? body.messages[0].content : "";
  const content = body.messages.at(-1).content;
  requests.push({ system, content });
  if (!system && JSON.stringify(content).includes("拒绝图片")) return new Reply(400, { error: { message: "image input unsupported" } });
  const answer = system.includes("宽召回") ? { label: JSON.stringify(content).includes("无关图") ? "BLOCK" : "PASS", reason: "图片公告" }
    : system.includes("事件注意力评分器") ? { attentionScore: JSON.stringify(content).includes("高分") ? 90 : 21 }
    : system.includes("资料结构化助手") ? { category: "ai-models", tags: ["模型"], subjects: [], fact: { title: "使用价格公告", subject: "交易中心", action: "公告", object: "API价格", occurredAt: null } }
    : system.includes("内容理解编辑") ? { itemType: "model_release", authorRole: "principal", tags: ["模型"], editorialJudgment: "图片提供价格", titleZh: "API使用价格公告", summaryZh: "图片公告列出使用价格4200美元/百万 token。" }
    : "title_zh: API使用价格公告\nsummary_zh: 图片公告列出使用价格4200美元/百万 token。";
  return { choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) } }] };
});
Object.assign(process.env, { LLM_MODEL: "vision-stub", LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_VISION: "true" });
for (const step of ["PREFILTER", "SCORE", "STRUCTURE", "UNDERSTAND", "SUMMARIZE"]) process.env[`${step}_MODEL`] = "default";
config.allowPrivateNetworkFetch = true;
config.modelCallsEnabled = true; // Every model and image request in this file goes to the local stubs above.
await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${`vision-${T}`}, '图片公告测试', 'web_list', 'T1', 'editorial')`;
after(async () => {
  await provider.close();
  await new Promise<void>((resolve) => images.close(() => resolve()));
  await closeDb();
});

async function article(label: string, missing = false) {
  const { articleId } = await upsertMaterial({ sourceId: `vision-${T}`, url: `https://example.org/${T}/${label}`, title: `API使用价格公告${label}-${T}`,
    bodyHtml: `<p><img src="${imageBase}/${missing ? "missing" : "price"}.png"><img src="${imageBase}/${missing ? "missing" : "second"}.png"></p>`,
    bodyText: "", bodyStatus: "ok", media: [{ kind: "image", url: `${imageBase}/logo.png` }], via: "fetch" });
  return (await loadAnalyzeInput(articleId))!;
}

test("all judging steps and the ordinary summary receive body pictures, not listing logos", async () => {
  const a = await article("低分");
  assert.deepEqual(a.media.map((m) => m.url), [`${imageBase}/price.png`, `${imageBase}/second.png`]);
  const run = await runAnalysis(a);
  assert.equal(run.writing?.kind, "summarize");
  assert.match(run.writing!.summaryZh, /4200美元\/百万 token/);
  assert.equal(requests.length, 5);
  for (const req of requests) {
    assert.ok(Array.isArray(req.content));
    assert.equal(req.content.filter((part: any) => part.type === "image_url").length, 2);
    assert.match(req.content[0].text, /未披露/);
    const data = req.content[1].image_url.url.split(",")[1];
    assert.equal((await sharp(Buffer.from(data, "base64")).metadata()).width, 1200, "no 720px thumbnail");
  }
  assert.equal(reads, 2, "one image download per URL across five model calls");
  const receipts = await sql`SELECT request FROM receipts WHERE subject = ${`article:${a.id}@${a.revision}`}`;
  assert.equal(receipts.length, 5);
  assert.ok(receipts.every((receipt) => receipt.request.imageCount === 2));
  await runAnalysis(a);
  assert.equal(requests.length, 5, "retries reuse the same paid receipts");
});

test("near-selected content understanding also receives all available body pictures", async () => {
  const run = await runAnalysis(await article("高分"));
  assert.equal(run.writing?.kind, "understand");
  const req = requests.find((request) => request.system.includes("内容理解编辑"))!;
  assert.equal(req.content.filter((part: any) => part.type === "image_url").length, 2);
});

test("a visual prefilter can block off-topic pictures, and rejected image requests do not fall back to text", async () => {
  const before = requests.length;
  const blocked = await runAnalysis(await article("无关图"));
  assert.equal(blocked.prefilter.label, "BLOCK");
  assert.equal(blocked.writing, null);
  assert.equal(requests.length, before + 1);
  await assert.rejects(runAnalysis(await article("拒绝图片")), /image input unsupported/);
  const writing = requests.filter((req) => !req.system && JSON.stringify(req.content).includes("拒绝图片"));
  assert.equal(writing.length, 1);
  assert.ok(Array.isArray(writing[0]!.content));
});

test("failed image downloads and non-vision models never write a title-only picture summary", async () => {
  const missing = await runAnalysis(await article("下载失败", true));
  assert.equal(missing.writing?.kind, "none");
  process.env.LLM_VISION = "false";
  const plain = await runAnalysis(await article("不支持图片"));
  assert.equal(plain.writing?.kind, "none");
  assert.ok(requests.slice(-4).every((req) => typeof req.content === "string"));
});
