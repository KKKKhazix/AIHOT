import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, afterEach, test } from "node:test";
import { promisify } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";

const T = `dims-${tag()}`;
const requests: Array<{ model: string; input: string[]; dimensions?: number }> = [];
type EmbeddingRequest = (typeof requests)[number];
const validResponse = (body: EmbeddingRequest) => ({ data: body.input.map((text, index) => ({
  index, embedding: Array.from({ length: body.dimensions ?? 6 }, (_, i) => Number(i === (text.includes(T) ? 0 : 1))),
})) });
let response: (body: EmbeddingRequest) => unknown = validResponse;
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  if (body.input) {
    requests.push(body);
    return response(body);
  }
  const answer = { query: "发布", decisions: [{ id: "C1", relation: "SAME_OCCURRENCE", confidence: 0.99, note: "" }] };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
});
// 配置必须早于向量模块导入，模型和密钥仅用于当前进程的本地模拟服务。
process.env.EMBEDDING_DIMS = "4";
process.env.EMBEDDING_MODEL = T;
process.env.EMBEDDING_API_KEY = "test-key";
process.env.EMBEDDING_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";
const { config } = await import("@aihot/backend/config");
const wasEnabled = config.modelCallsEnabled;
config.modelCallsEnabled = true;
const { EMBEDDING_MODEL, ensureEmbeddings, cosine } = await import("@aihot/backend/providers/embeddings");
const { groupArticle } = await import("@aihot/backend/events/group");
const { warmRecallWindow } = await import("@aihot/backend/events/recall");
const { reportText } = await import("@aihot/backend/events/relate");
const { upsertMaterial } = await import("@aihot/backend/content/materials");
const { publishArticle } = await import("@aihot/backend/publication/publish");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const storyIds: number[] = [];
let serial = 0;
const item = () => ({ id: `${T}-${++serial}`, text: `${T} text ${serial}` });

async function stored(kind: "fact" | "article" | "story", it: { id: string; text: string }, vector: number[], model = EMBEDDING_MODEL) {
  await sql`INSERT INTO embeddings(kind,ref_id,model,text_hash,vector)
    VALUES(${kind},${it.id},${model},${sha256(it.text)},${vector})
    ON CONFLICT(kind,ref_id,model) DO UPDATE SET text_hash=EXCLUDED.text_hash,vector=EXCLUDED.vector`;
}
async function persisted(kind: string, id: string) {
  return (await sql<{ vector: number[] }[]>`SELECT vector FROM embeddings WHERE kind=${kind} AND ref_id=${id} AND model=${EMBEDDING_MODEL}`)[0]?.vector;
}
async function report() {
  const it = item();
  const source = `${it.id}-source`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${source},${source},'rss','T1','editorial','2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${it.id}`, title: it.text,
    bodyText: "Synthetic report.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,output)
    VALUES(${articleId},1,'rule','pass','ai-models',${it.text},'摘要',80,false,${sql.json({ fact: { title: it.text } })})`;
  await publishArticle(articleId);
  return { id: articleId, text: reportText(it.text, "摘要") };
}
async function existingReport() {
  const reportItem = await report();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(${randomUUID()},${T},now(),now()) RETURNING id`;
  storyIds.push(Number(story!.id));
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title)
    VALUES(${randomUUID()},${story!.id},${T}) RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id) VALUES(${fact!.id},${reportItem.id})`;
  return { item: reportItem, storyId: Number(story!.id), factId: Number(fact!.id) };
}
async function freshProcess(dimensions: number, code: string) {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const { ensureEmbeddings, cosine } = await import('@aihot/backend/providers/embeddings');
    const { closeDb } = await import('@aihot/backend/db');
    try { ${code} } finally { await closeDb(); }
  `], { env: { ...process.env, EMBEDDING_DIMS: String(dimensions), MODEL_CALLS_ENABLED: "true" } });
  return JSON.parse(stdout);
}

afterEach(async () => {
  response = validResponse;
  await sql`DELETE FROM embeddings WHERE model LIKE ${T + "%"}`;
  if (storyIds.length) {
    await sql`DELETE FROM facts WHERE story_id=ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM stories WHERE id=ANY(${storyIds.splice(0)}::bigint[])`;
  }
  await sql`DELETE FROM articles WHERE source_id LIKE ${T + "%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${T + "%"}`;
});
after(async () => {
  config.modelCallsEnabled = wasEnabled;
  await provider.close();
  await stopBoss();
  await closeDb();
});

for (const oldLength of [2, 8]) test(`same model and text refresh stored dimension${oldLength} to requested dimension4`, async () => {
  const it = item();
  await stored("article", it, Array.from({ length: oldLength }, (_, i) => Number(i === 0)));
  const before = requests.length;
  const got = await ensureEmbeddings("article", [it]);
  assert.deepEqual(got.get(it.id), [1, 0, 0, 0], "stale vector is replaced, never reused or cropped");
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1)!.dimensions, 4);
  assert.deepEqual(await persisted("article", it.id), [1, 0, 0, 0]);
});

test("compatible database/fact cache hits preserve precision, text changes and kind isolation", async () => {
  const it = item();
  await stored("fact", it, [0.123456789, 0.987654321, 0, 0]);
  const vector = await persisted("fact", it.id);
  const before = requests.length;
  assert.deepEqual((await ensureEmbeddings("fact", [it])).get(it.id), vector);
  assert.deepEqual((await ensureEmbeddings("fact", [it])).get(it.id), vector);
  await stored("article", it, [0, 1, 0, 0]);
  assert.deepEqual((await ensureEmbeddings("article", [it])).get(it.id), [0, 1, 0, 0]);
  assert.equal(requests.length, before);
  const changed = { ...it, text: it.text + " changed" };
  assert.deepEqual((await ensureEmbeddings("fact", [changed])).get(it.id), [1, 0, 0, 0]);
  assert.equal(requests.length, before + 1);
});

test("incompatible cached fact vectors fall back to a compatible stored vector", async () => {
  const it = item();
  await stored("fact", it, [1, 0, 0, 0]);
  const before = requests.length;
  const cached = (await ensureEmbeddings("fact", [it])).get(it.id)!;
  cached.pop();
  assert.deepEqual((await ensureEmbeddings("fact", [it])).get(it.id), [1, 0, 0, 0]);
  assert.equal(requests.length, before);
});

test("nonfinite and empty stored vectors are refreshed", async () => {
  for (const vector of [[], [NaN, 0, 0, 0], [Infinity, 0, 0, 0]]) {
    const it = item();
    await stored("story", it, vector);
    const before = requests.length;
    assert.deepEqual((await ensureEmbeddings("story", [it])).get(it.id), [1, 0, 0, 0]);
    assert.equal(requests.length, before + 1);
  }
});

test("warm-up refreshes wrong dimensions and wrong models then makes no new requests", async () => {
  const wrongSize = await existingReport();
  const wrongModel = await existingReport();
  await stored("article", wrongSize.item, [1, 0]);
  await stored("article", wrongModel.item, [1, 0, 0, 0], `${EMBEDDING_MODEL}-old`);
  const before = requests.length;
  const first = await warmRecallWindow();
  assert.ok(first.embedded >= 2);
  assert.ok(requests.length > before);
  assert.deepEqual(await persisted("article", wrongSize.item.id), [1, 0, 0, 0]);
  assert.deepEqual(await persisted("article", wrongModel.item.id), [1, 0, 0, 0]);
  const warmed = requests.length;
  assert.equal((await warmRecallWindow()).embedded, 0);
  assert.equal(requests.length, warmed);
});

test("grouping refreshes an old-length report and joins its existing fact with a finite score", async () => {
  const existing = await existingReport();
  await stored("article", existing.item, [1, 0]);
  const query = await report();
  const result = await groupArticle(query.id);
  if (result.storyId && result.storyId !== existing.storyId) storyIds.push(result.storyId);
  assert.equal(result.verdict, "same-fact", "dimension changes must not split a related report into a new story");
  assert.equal(result.factId, existing.factId);
  assert.equal(result.storyId, existing.storyId);
  const [decision] = await sql<{ candidates: Array<{ id: number; score: number }> }[]>`
    SELECT candidates FROM grouping_decisions WHERE article_id=${query.id} ORDER BY id DESC LIMIT 1`;
  const candidate = decision!.candidates.find((c) => c.id === existing.factId)!;
  assert.ok(candidate && Number.isFinite(candidate.score));
  assert.equal(candidate.score, 1);
});

for (const typed of [false, true]) test(`cosine guards ${typed ? "Float32Array recall" : "number array"} inputs without prefix comparison`, () => {
  const make = (v: number[]) => typed ? Float32Array.from(v) : v;
  assert.equal(cosine(make([1, 0]), make([1, 0, 10])), 0);
  assert.equal(cosine(make([1, 0, 10]), make([1, 0])), 0);
  assert.equal(cosine(make([]), make([])), 0);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(cosine(make([value, 1]), make([1, 0])), 0);
    assert.equal(cosine(make([1, 0]), make([value, 1])), 0);
  }
  assert.equal(cosine(make([0, 0]), make([1, 0])), 0);
  assert.equal(cosine(make([1, 0]), make([1, 0])), 1);
  assert.equal(cosine(make([1, 0]), make([-1, 0])), -1);
  assert.equal(cosine(make([1, 0]), make([0, 1])), 0);
});

const invalidResponses: Array<[string, (body: EmbeddingRequest) => unknown]> = [
  ["wrong dimension", (b) => ({ data: b.input.map((_, index) => ({ index, embedding: [1, 0] })) })],
  ["empty vector", (b) => ({ data: b.input.map((_, index) => ({ index, embedding: [] })) })],
  ["nonfinite coordinate", (b) => ({ data: b.input.map((_, index) => ({ index, embedding: [NaN, 0, 0, 0] })) })],
  ["nonnumeric coordinate", (b) => ({ data: b.input.map((_, index) => ({ index, embedding: ["1", 0, 0, 0] })) })],
  ["missing result", () => ({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] })],
  ["duplicate index", () => ({ data: [0, 0].map((index) => ({ index, embedding: [1, 0, 0, 0] })) })],
  ["out-of-range index", () => ({ data: [0, 2].map((index) => ({ index, embedding: [1, 0, 0, 0] })) })],
  ["fractional index", () => ({ data: [0, 0.5].map((index) => ({ index, embedding: [1, 0, 0, 0] })) })],
  ["negative index", () => ({ data: [-1, 0].map((index) => ({ index, embedding: [1, 0, 0, 0] })) })],
  ["missing data", () => ({})],
];
for (const [name, answer] of invalidResponses) test(`invalid ${name} response writes no embeddings and reuses the receipt`, async () => {
  response = answer;
  const items = [item(), item()];
  const before = requests.length;
  await assert.rejects(ensureEmbeddings("article", items));
  assert.equal(requests.length, before + 1);
  assert.equal(await persisted("article", items[0]!.id), undefined);
  assert.equal(await persisted("article", items[1]!.id), undefined);
  await assert.rejects(ensureEmbeddings("article", items));
  assert.equal(requests.length, before + 1, "invalid received response is not paid for again");
  const [receipt] = await sql<{ status: string; attempts: number }[]>`
    SELECT status,attempts FROM receipts WHERE model=${EMBEDDING_MODEL} AND subject=${`article:${items[0]!.id}`}`;
  assert.equal(receipt!.status, "received");
  assert.equal(receipt!.attempts, 1);
});

test("valid reordered batch indices preserve input mapping", async () => {
  response = () => ({ data: [{ index: 1, embedding: [0, 1, 0, 0] }, { index: 0, embedding: [1, 0, 0, 0] }] });
  const items = [item(), item()];
  const got = await ensureEmbeddings("article", items);
  assert.deepEqual(got.get(items[0]!.id), [1, 0, 0, 0]);
  assert.deepEqual(got.get(items[1]!.id), [0, 1, 0, 0]);
});

test("a restarted process with changed dimensions gets a distinct paid receipt", async () => {
  const it = item();
  const before = requests.length;
  assert.equal((await ensureEmbeddings("article", [it])).get(it.id)!.length, 4);
  const length = await freshProcess(2, `console.log((await ensureEmbeddings('article', [${JSON.stringify(it)}])).get(${JSON.stringify(it.id)}).length);`);
  assert.equal(length, 2);
  assert.equal(requests.length, before + 2);
  assert.deepEqual(requests.slice(-2).map((r) => r.dimensions), [4, 2]);
  assert.equal((await persisted("article", it.id))!.length, 2);
  const rows = await sql`SELECT DISTINCT logical_key FROM receipts WHERE model=${EMBEDDING_MODEL} AND subject=${`article:${it.id}`}`;
  assert.equal(rows.length, 2);
});

test("provider-default mode reuses valid stored sizes and omits dimensions for new requests", async () => {
  const old = item();
  const fresh = item();
  await stored("article", old, [1, 0]);
  const before = requests.length;
  const got = await freshProcess(0, `
    const old = (await ensureEmbeddings('article', [${JSON.stringify(old)}])).get(${JSON.stringify(old.id)});
    const fresh = (await ensureEmbeddings('article', [${JSON.stringify(fresh)}])).get(${JSON.stringify(fresh.id)});
    console.log(JSON.stringify({ old: old.length, fresh: fresh.length, score: cosine(old, fresh) }));
  `);
  assert.deepEqual(got, { old: 2, fresh: 6, score: 0 });
  assert.equal(requests.length, before + 1);
  assert.equal(Object.hasOwn(requests.at(-1)!, "dimensions"), false);
});
