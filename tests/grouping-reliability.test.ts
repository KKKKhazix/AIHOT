// Failure modes: unavailable identity requests must remain undecided, an incomplete model response
// must not become "unrelated", and releasing an unknown receipt must resume the exact grouping job
// that a native TimeoutError failed. Lost pending jobs, of reports and discussion posts alike, must
// recover without reviving terminal failures or buying the same request indefinitely.
import { embeddingsStub, gate, pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { MODELS } from "@aihot/backend/providers/llm";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { BatchSchema, PairSchema, verdictsByFact, type CandidateView } from "@aihot/backend/events/relate";
import { detachFromFact, requestRegroup } from "@aihot/backend/events/corrections";
import { settleNonEditorial } from "@aihot/backend/jobs/content";
import { sweepUngrouped } from "@aihot/backend/jobs/events";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { recoverStaleWork, releaseReceipt } from "@aihot/backend/operations/recover";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const sourceId = `group-reliability-${T}`;
const signalSource = `group-reliability-signal-${T}`;
let response: "complete" | "missing" = "complete";
const provider = await stub((_hit, request) => {
  const body = JSON.parse(request.body);
  const text = body.messages[1].content as string;
  if (text.includes("【报道 A】")) return { choices: [{ message: { content: JSON.stringify({ a: "发布", b: "发布", relation: "SAME_OCCURRENCE", difference: "", confidence: 1 }) } }] };
  const ids = [...text.matchAll(/【候选 (C\d+)】/g)].map(m => m[1]);
  return { choices: [{ message: { content: JSON.stringify({ query: "新模型发布", decisions: (response === "missing" ? [] : ids).map(id => ({ id, relation: "SAME_OCCURRENCE", confidence: 1, note: "" })), selection: { addsValue: true, reason: "fixture news" } }) } }] };
});
pointModels(provider.url, ["deepseek-flash", "mimo-v2.6-flash", "glm-5.3-flash"]);
MODELS["test-group-primary"] = { ...MODELS["deepseek-flash"]!, key: "test-group-primary" };
MODELS["test-group-backup"] = { ...MODELS["glm-5.3-flash"]!, key: "test-group-backup", fallbackFor: { group: "test-group-primary" } };
process.env.GROUP_MODEL = "test-group-primary";
process.env.GROUP_REVIEW_MODEL = "mimo-v2.6-flash";
const embeddings = await embeddingsStub();
let factId: number;

async function report(suffix: string, composite = false) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/group-${T}/${suffix}`, title: `新模型发布${T}`, bodyText: "今日发布新模型和价格。", bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 60_000) });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,output)
    VALUES (${articleId},1,'rule','pass','ai-models',${`新模型发布${T} ${suffix}`},${`新模型发布和价格${T} ${suffix}`},80,true,${sql.json({ scope: composite ? "composite" : "single", fact: { title: "新模型发布", subject: "实验室", action: "发布", object: "模型" } })})`;
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  await publishArticle(articleId);
  return articleId;
}

/** A discussion post as collection leaves it: recorded, then handed to grouping. */
async function post(suffix: string, history = false) {
  const { articleId } = await upsertMaterial({ sourceId: signalSource, url: `https://example.org/group-${T}/${suffix}`, title: `讨论新模型发布${T} ${suffix}`, via: "fetch",
    publishedAt: history ? new Date(Date.now() - 30 * 86400_000) : new Date(), backfill: history ? "test history" : null });
  await settleNonEditorial(articleId);
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at) VALUES (${sourceId},'Group reliability','rss','T1','editorial','2100-01-01'),
    (${signalSource},'Group reliability signal','rss','T2','hot_signal','2100-01-01')`;
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

// The grouping decision and the paid result it consumes must commit together. Without this,
// a failed completion can leave an article grouped while its paid response stays "received".
for (const kind of ["report", "roundup", "kept"] as const) test(`receipt completion failure rolls back ${kind} grouping and recovery reuses the response`, async (t) => {
  // Both attempts read the selected set at one instant, so the recovery repeats the same request even when the VM's
  // clock steps back between them (on the CI VMs by as much as 0.4 s).
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const id = await report(`receipt-atomic-${kind}`, kind === "roundup");
  if (kind === "kept") {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${id}, 'report')`;
    await sql`UPDATE articles SET selection_adds_value = NULL WHERE id = ${id}`;
  }
  await sql.unsafe(`CREATE FUNCTION fail_grouping_receipt() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN
    IF NEW.status = 'completed' AND NEW.purpose = 'group_article'
      THEN RAISE EXCEPTION 'grouping receipt commit interrupted';
    END IF;
    RETURN NEW; END $body$`);
  await sql`CREATE TRIGGER fail_grouping_receipt BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION fail_grouping_receipt()`;
  const before = provider.hits();
  try {
    await assert.rejects(groupArticle(id), /grouping receipt commit interrupted/);
  } finally {
    await sql`DROP TRIGGER fail_grouping_receipt ON receipts`;
    await sql`DROP FUNCTION fail_grouping_receipt()`;
  }
  const after = provider.hits();
  assert.ok(after > before, "the model response was received before the injected commit failure");
  assert.equal((await sql`SELECT 1 FROM grouping_decisions WHERE article_id = ${id}`).length, 0, "the decision must roll back");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${id}`).length, kind === "kept" ? 1 : 0,
    "no new membership can commit when receipt completion fails");
  const [failed] = await sql<{ grouping_status: string }[]>`SELECT grouping_status FROM articles WHERE id = ${id}`;
  assert.equal(failed!.grouping_status, "failed");
  const receipts = await sql<{ purpose: string; status: string }[]>`
    SELECT purpose, status FROM receipts WHERE purpose IN ('group_article', 'group_review')
      AND subject LIKE ${`article:${id}%`} ORDER BY id`;
  assert.ok(receipts.some((receipt) => receipt.purpose === "group_article"), "the batch judgement has a receipt");
  assert.ok(receipts.every((receipt) => receipt.status === "received"), "no receipt completes on a rolled-back decision");

  const result = await groupArticle(id);
  assert.equal(result.verdict, kind === "roundup" ? "roundup" : kind === "kept" ? "kept" : "same-fact");
  assert.equal(provider.hits(), after, "recovery must reuse the already paid response");
  const completed = await sql<{ status: string }[]>`
    SELECT status FROM receipts WHERE purpose IN ('group_article', 'group_review')
      AND subject LIKE ${`article:${id}%`}`;
  assert.equal(completed.length, receipts.length);
  assert.ok(completed.every((receipt) => receipt.status === "completed"));
  assert.equal((await sql`SELECT 1 FROM grouping_decisions WHERE article_id = ${id}`).length, 1);
});

test("primary timeout continues through the backup; two timeouts wait for release of the actual blocked job", async () => {
  const continuedId = await report("backup-continues");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(provider.url) && JSON.parse(String(init?.body)).model === "deepseek-flash") throw new DOMException("request timed out", "TimeoutError");
    return realFetch(input, init);
  };
  try { assert.equal((await groupArticle(continuedId)).verdict, "same-fact"); }
  finally { globalThis.fetch = realFetch; }
  const paid = await sql`SELECT service,status FROM receipts WHERE purpose='group_article' AND subject=${`article:${continuedId}`} ORDER BY id`;
  assert.deepEqual(paid.map(r => [r.service,r.status]), [["deepseek","unknown"],["zhipu","completed"]]);
  const hits = provider.hits();
  await groupArticle(continuedId);
  assert.equal(provider.hits(), hits, "the completed identity is not judged again after primary recovery");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${continuedId}`).length, 1);
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
  // Queued and taken a minute before the release, as when a paid call times out: the stamps keep their order even
  // when the VM's clock steps back (on the CI VMs by as much as 0.4 s).
  const jobId = await enqueue(QUEUES.group, data, { retryLimit: 0, singletonKey: id, startAfter: new Date(Date.now() - 60_000) });
  await boss.fetch(QUEUES.group);
  await sql`UPDATE pgboss.job SET started_on = started_on - interval '1 minute' WHERE id = ${jobId!}`;
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

/** The sweep's jobs, queued a minute ago: the fetch's `start_after <= now` holds even when the VM's clock steps back (on the CI VMs by as much as 0.4 s). */
const queuedMinuteAgo = () => sql`UPDATE pgboss.job SET start_after = start_after - interval '1 minute' WHERE name = ${QUEUES.group} AND state = 'created'`;

/** Ways a grouping attempt can fail to reach any model: each runs the attempt while it lasts. */
const waits: Record<string, (attempt: () => Promise<unknown>) => Promise<void>> = {
  "a spent budget": async (attempt) => {
    const budgets = await sql`SELECT service,per_minute,per_hour,per_day FROM budgets`;
    const hits = provider.hits();
    try {
      await sql`UPDATE budgets SET per_minute=0,per_hour=0,per_day=0`;
      await assert.rejects(attempt(), /Budget for .* exhausted/);
      assert.equal(provider.hits(), hits, "no model request is sent while waiting for budget");
    } finally {
      for (const b of budgets) await sql`UPDATE budgets SET per_minute=${b.per_minute},per_hour=${b.per_hour},per_day=${b.per_day} WHERE service=${b.service}`;
    }
  },
  "a provider outage on primary and backup": async (attempt) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => [provider.url, embeddings.url].some((url) => String(input).startsWith(url))
      ? new Response(JSON.stringify({ error: "overloaded" }), { status: 503, headers: { "content-type": "application/json" } })
      : realFetch(input, init);
    try { await assert.rejects(attempt(), /503/); }
    finally {
      globalThis.fetch = realFetch;
      await sql`DELETE FROM settings WHERE key LIKE 'model.circuit.%'`;
    }
  },
};

// A discussion post's grouping job outlives a long wait no better than a report's: once its queue
// retries are spent, only the repair sweep queues it again.
for (const [cause, during] of Object.entries(waits)) for (const material of ["report", "discussion post"] as const) {
  test(`${cause} leaves a ${material}'s grouping pending and the repair sweep resumes it`, async () => {
    const signalOnly = material === "discussion post";
    const suffix = `${cause}-${material}`.replaceAll(" ", "-");
    const id = signalOnly ? await post(suffix) : await report(suffix);
    await during(() => groupArticle(id, { signalOnly }));
    assert.equal((await sql`SELECT grouping_status FROM articles WHERE id=${id}`)[0]!.grouping_status, "pending");
    await sql`UPDATE articles SET created_at=now()-interval '5 minutes' WHERE id=${id}`;
    assert.equal((await sweepUngrouped()).enqueued, 1);
    assert.equal((await sweepUngrouped()).enqueued, 0);
    const [queued] = await sql<{ priority: number }[]>`SELECT priority FROM pgboss.job WHERE name=${QUEUES.group} AND data->>'articleId'=${id} AND state='created'`;
    assert.equal(queued!.priority, signalOnly ? -1 : 0, "queued again in its first place");
    const boss = await getBoss();
    await queuedMinuteAgo();
    const jobs = await boss.fetch(QUEUES.group);
    assert.deepEqual(jobs.map(job => job.data), [signalOnly ? { articleId: id, signalOnly } : { articleId: id }]);
    const { verdict } = await groupArticle(id, { signalOnly });
    if (!signalOnly) assert.equal(verdict, "same-fact");
    await boss.complete(QUEUES.group, jobs[0]!.id);
    assert.equal((await sql`SELECT grouping_status FROM articles WHERE id=${id}`)[0]!.grouping_status, "complete");
  });
}

// Failure mode: the sweep founds work for posts the pipeline never groups (history adds no heat).
test("the repair sweep leaves discussion posts that are history", async () => {
  const id = await post("sweep-history-post", true);
  await sql`UPDATE articles SET created_at=now()-interval '5 minutes' WHERE id=${id}`;
  assert.equal((await sql`SELECT grouping_status FROM articles WHERE id=${id}`)[0]!.grouping_status, "pending");
  assert.equal((await sweepUngrouped()).enqueued, 0);
});

test("a lost pending grouping job is repaired once, but a terminal failure waits for recovery", async () => {
  const pending = await report("lost");
  const failed = await report("terminal");
  await sql`UPDATE articles SET created_at=now()-interval '5 minutes' WHERE id IN (${pending},${failed})`;
  await sql`UPDATE articles SET grouping_status='failed',grouping_error='requires review' WHERE id=${failed}`;
  assert.equal((await sweepUngrouped()).enqueued, 1);
  assert.equal((await sweepUngrouped()).enqueued, 0);
  const boss = await getBoss();
  await queuedMinuteAgo();
  const jobs = await boss.fetch(QUEUES.group);
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0]!.data as { articleId: string }).articleId, pending);
  await groupArticle(pending);
  await boss.complete(QUEUES.group, jobs[0]!.id);
  await detachFromFact(failed, "verified independent", "test");
  const [manual] = await sql`SELECT grouping_status,grouping_error FROM articles WHERE id=${failed}`;
  assert.deepEqual({ ...manual }, { grouping_status: "complete", grouping_error: null });
});

// Failure mode: a bulk repair of old articles is queued as live work and holds up today's news.
test("the repair sweep keeps history behind live work", async () => {
  const old = await report("sweep-history");
  const live = await report("sweep-live");
  await sql`UPDATE articles SET backfill=true,published_at=now()-interval '30 days' WHERE id=${old}`;
  await sql`UPDATE articles SET created_at=now()-interval '5 minutes' WHERE id IN (${old},${live})`;
  assert.equal((await sweepUngrouped()).enqueued, 2);
  const queued = await sql<{ article: string; priority: number }[]>`
    SELECT data->>'articleId' AS article, priority FROM pgboss.job WHERE name=${QUEUES.group} AND data->>'articleId' IN (${old},${live})`;
  assert.deepEqual(Object.fromEntries(queued.map((j) => [j.article, j.priority])), { [old]: -2, [live]: 0 });
  const boss = await getBoss();
  for (const job of [...await boss.fetch(QUEUES.group), ...await boss.fetch(QUEUES.group)]) {
    await groupArticle((job.data as { articleId: string }).articleId);
    await boss.complete(QUEUES.group, job.id);
  }
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
    await upsertMaterial({ sourceId, url: `https://example.org/group-${T}/${suffix}`, title: `Corrected material ${T}`, bodyText: "A different product and corrected report.", bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 60_000) });
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
    await upsertMaterial({ sourceId, url: `https://example.org/group-${T}/${suffix}`, title: `Changed original ${T}`, bodyText: "New corrected material.", bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 60_000) });
  } else {
    await sql.begin(tx => requestRegroup(id, `request-${T}`, tx));
  }
  const [current] = await sql`SELECT a.grouping_status,p.selected FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.id=${id}`;
  assert.deepEqual({ ...current }, { grouping_status: "pending", selected: false });
});
