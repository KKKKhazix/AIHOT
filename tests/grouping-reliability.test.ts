// Failure modes: unavailable identity requests must remain undecided, an incomplete model response
// must not become "unrelated", and releasing an unknown receipt must resume the exact grouping job
// that a native TimeoutError failed. Lost pending jobs must recover without reviving terminal
// failures or buying the same request indefinitely.
import { embeddingsStub, gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { BatchSchema, PairSchema, verdictsByFact, type CandidateView } from "@aihot/backend/events/relate";
import { detachFromFact, requestRegroup } from "@aihot/backend/events/corrections";
import { sweepUngrouped } from "@aihot/backend/jobs/events";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { recoverStaleWork, releaseReceipt } from "@aihot/backend/operations/recover";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const sourceId = `group-reliability-${T}`;
let response: "complete" | "missing" = "complete";
const provider = await stub((_hit, request) => {
  const body = JSON.parse(request.body);
  const text = body.messages[1].content as string;
  if (text.includes("【报道 A】")) return { choices: [{ message: { content: JSON.stringify({ a: "发布", b: "发布", relation: "SAME_OCCURRENCE", difference: "", confidence: 1 }) } }] };
  const ids = [...text.matchAll(/【候选 (C\d+)】/g)].map(m => m[1]);
  return { choices: [{ message: { content: JSON.stringify({ query: "新模型发布", decisions: (response === "missing" ? [] : ids).map(id => ({ id, relation: "SAME_OCCURRENCE", confidence: 1, note: "" })), selection: { addsValue: true, reason: "fixture news" } }) } }] };
});
for (const name of ["DEEPSEEK", "XIAOMI_MIMO"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "test-key";
}
const embeddings = await embeddingsStub();
let factId: number;

async function report(suffix: string, composite = false) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/group-${T}/${suffix}`, title: `新模型发布${T}`, bodyText: "今日发布新模型和价格。", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,output)
    VALUES (${articleId},1,'rule','pass','ai-models',${`新模型发布${T} ${suffix}`},${`新模型发布和价格${T} ${suffix}`},80,true,${sql.json({ scope: composite ? "composite" : "single", fact: { title: "新模型发布", subject: "实验室", action: "发布", object: "模型" } })})`;
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  await publishArticle(articleId);
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at) VALUES (${sourceId},'Group reliability','rss','T1','editorial','2100-01-01')`;
  const id = await report("root");
  const [story] = await sql`INSERT INTO stories (public_id,title) VALUES (${randomUUID()},'新模型发布') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts (public_id,story_id,title) VALUES (${`f-${T}`},${story!.id},'新模型发布') RETURNING id`;
  factId = Number(fact!.id);
  await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${factId},${id},'primary')`;
  await groupArticle(id);
});
after(async () => { await provider.close(); await embeddings.close(); await stopBoss(); await closeDb(); });

test("missing and invalid identity answers cannot silently assert unrelated", () => {
  assert.equal(BatchSchema.safeParse({}).success, false);
  assert.equal(BatchSchema.safeParse({ decisions: [{ id: "C1", relation: "TYPO", confidence: 0.99 }] }).success, false);
  assert.equal(BatchSchema.safeParse({ decisions: [{ relation: "SAME_OCCURRENCE", confidence: 1 }] }).success, false);
  assert.equal(PairSchema.safeParse({}).success, false);
  const cands = [{ factId: 1 }, { factId: 2 }] as CandidateView[];
  assert.throws(() => verdictsByFact([{ id: "C1", relation: "UNRELATED", confidence: 1 }], cands), /candidate|候选/i);
  assert.throws(() => verdictsByFact([{ id: "C1", relation: "UNRELATED", confidence: 1 }, { id: "C1", relation: "UNRELATED", confidence: 1 }], cands), /candidate|候选/i);
});

for (const composite of [false, true]) test(`a ${composite ? "roundup" : "single report"} with an incomplete answer stays unresolved and can recover`, async () => {
  const id = await report(composite ? "roundup" : "incomplete", composite);
  response = "missing";
  await assert.rejects(groupArticle(id), /unusable output/);
  const [failed] = await sql`SELECT grouped_at,grouping_status,grouping_receipt_id FROM articles WHERE id=${id}`;
  assert.equal(failed!.grouped_at, null);
  assert.equal(failed!.grouping_status, "failed");
  assert.ok(failed!.grouping_receipt_id);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length, 0);
  response = "complete";
  const result = await groupArticle(id);
  assert.equal(result.verdict, composite ? "roundup" : "same-fact");
  const [done] = await sql`SELECT grouped_at,grouping_status,grouping_receipt_id,grouping_error FROM articles WHERE id=${id}`;
  assert.equal(done!.grouping_status, "complete");
  assert.ok(done!.grouped_at);
  assert.equal(done!.grouping_receipt_id, null);
  assert.equal(done!.grouping_error, null);
});

test("a native timeout fails its job with the receipt id, and the release wakes that same job", async () => {
  const id = await report("timeout");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(provider.url)) throw new DOMException("request timed out", "TimeoutError");
    return originalFetch(input, init);
  };
  let error: unknown;
  try { await groupArticle(id); } catch (thrown) { error = thrown; } finally { globalThis.fetch = originalFetch; }
  assert.match(String(error), /timed out/);
  const [failed] = await sql`SELECT grouping_status,grouping_receipt_id FROM articles WHERE id=${id}`;
  assert.equal(failed!.grouping_status, "failed");
  assert.ok(failed!.grouping_receipt_id);
  // The job's handler fails with what groupArticle threw: the queue stores that error, receipt id included.
  const boss = await getBoss();
  const data = { articleId: id };
  const jobId = await enqueue(QUEUES.group, data, { retryLimit: 0, singletonKey: id });
  await boss.fetch(QUEUES.group);
  await boss.fail(QUEUES.group, jobId!, error as Error);
  await releaseReceipt(Number(failed!.grouping_receipt_id), { billed: false, note: "local fixture verified" }, "test");
  await recoverStaleWork();
  const jobs = await boss.fetch(QUEUES.group);
  assert.deepEqual(jobs.map((job) => [job.id, job.data]), [[jobId, data]]);
  assert.equal((await groupArticle(id)).verdict, "same-fact");
  await boss.complete(QUEUES.group, jobs[0]!.id);
  await sweepUngrouped();
  assert.equal((await boss.fetch(QUEUES.group)).length, 0, "successful work is not repeatedly queued");
});

test("a lost pending grouping job is repaired once, but a terminal failure waits for recovery", async () => {
  const pending = await report("lost");
  const failed = await report("terminal");
  await sql`UPDATE articles SET created_at=now()-interval '5 minutes' WHERE id IN (${pending},${failed})`;
  await sql`UPDATE articles SET grouping_status='failed',grouping_error='requires review' WHERE id=${failed}`;
  assert.equal((await sweepUngrouped()).enqueued, 1);
  assert.equal((await sweepUngrouped()).enqueued, 0);
  const boss = await getBoss();
  const jobs = await boss.fetch(QUEUES.group);
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0]!.data as { articleId: string }).articleId, pending);
  await groupArticle(pending);
  await boss.complete(QUEUES.group, jobs[0]!.id);
  await detachFromFact(failed, "verified independent", "test");
  const [manual] = await sql`SELECT grouping_status,grouping_error FROM articles WHERE id=${failed}`;
  assert.deepEqual({ ...manual }, { grouping_status: "complete", grouping_error: null });
});


// Failure modes: a report changes while its old model response is in flight; neither the old answer
// nor a late timeout may complete or fail the replacement revision.
for (const lateFailure of [false, true]) test(`an old grouping ${lateFailure ? "failure" : "answer"} cannot settle a changed material`, async () => {
  const suffix = lateFailure ? "revision-failure" : "revision-answer";
  const id = await report(suffix);
  const asked = gate();
  const release = gate();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(provider.url)) {
      asked.open();
      await release.promise;
      if (lateFailure) throw new DOMException("old request timed out", "TimeoutError");
    }
    return originalFetch(input, init);
  };
  const grouping = groupArticle(id);
  const rejected = assert.rejects(grouping);
  try {
    await asked.promise;
    await upsertMaterial({ sourceId, url: `https://example.org/group-${T}/${suffix}`, title: `Corrected material ${T}`, bodyText: "A different product and corrected report.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    release.open();
    await rejected;
  } finally { release.open(); globalThis.fetch = originalFetch; }
  const [current] = await sql`SELECT revision,grouping_status,grouping_error,grouping_receipt_id,selection_adds_value FROM articles WHERE id=${id}`;
  assert.deepEqual({ ...current }, { revision: 2, grouping_status: "pending", grouping_error: null, grouping_receipt_id: null, selection_adds_value: null });
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${id}`).length, 0);
});


// Failure mode: a pending decision is recorded but an old public projection still exposes it as selected.
for (const change of ["revision", "regroup"] as const) test(`${change} withdraws the old selected projection in the same transaction`, async () => {
  const suffix = `withdraw-${change}`;
  const id = await report(suffix);
  await groupArticle(id);
  assert.equal((await sql`SELECT selected FROM publications WHERE article_id=${id}`)[0]!.selected, true);
  if (change === "revision") {
    await upsertMaterial({ sourceId, url: `https://example.org/group-${T}/${suffix}`, title: `Changed original ${T}`, bodyText: "New corrected material.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  } else {
    await sql.begin(tx => requestRegroup(id, `request-${T}`, tx));
  }
  const [current] = await sql`SELECT a.grouping_status,p.selected FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.id=${id}`;
  assert.deepEqual({ ...current }, { grouping_status: "pending", selected: false });
});
