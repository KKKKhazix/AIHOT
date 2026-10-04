// Detail limits must leave the tail recoverable without reporting a broken publisher; a worker
// shutdown must not turn its remaining paid detail work into a successful run full of failures.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { shutdownSignal, stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
const publishedAt = new Date(Date.now() - 60_000).toISOString();
const reads: string[] = [];
let stopOnDetail = false;
const server = http.createServer((req, res) => {
  const target = req.url!.slice(1);
  const listing = target.endsWith("/listing");
  reads.push(target);
  if (!listing && stopOnDetail) shutdownSignal.abort();
  res.setHeader("content-type", "text/plain");
  const root = target.slice(0, target.lastIndexOf("/"));
  const content = listing ? [0, 1, 2].map(i => `[Article ${i}](${root}/detail-${i})`).join("\n") : "Article content";
  res.end(`Title: Article\nURL Source: ${target}\nPublished Time: ${publishedAt}\nMarkdown Content:\n${content}`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
config.allowPrivateNetworkFetch = true;
process.env.JINA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-key";
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

async function source(name: string) {
  const id = `detail-${T}-${name}`;
  const sourceConfig = { url: `https://r.jina.ai/https://publisher.example/${id}/listing`, parseMode: "markdown",
    detail: { maxFetches: 5, publishedAtRegex: "Published Time:\\s*(\\S+)" } };
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,cursor,next_fetch_at)
    VALUES(${id},${id},'web_list','T1','hot_signal',${sql.json(sourceConfig)},
      ${sql.json({ initializedAt: new Date().toISOString() })},'2100-01-01')`;
  return id;
}

test("the minute budget stops unsent details, retains the listing and recovers the tail on later runs", async () => {
  await sql`UPDATE budgets SET per_minute=2,per_hour=1000,per_day=1000 WHERE service='jina'`;
  const id = await source("budget");
  const collected = await collectSource(id);
  assert.equal(collected.status, "ok");
  assert.equal(collected.created, 3);
  assert.equal(reads.filter(url => url.includes(id)).length, 2, "one listing and one paid detail fit the budget");
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.detail.detailAttempts, 2, "the first blocked attempt ends this run's detail work");
  assert.equal(run!.detail.detailFailures, 0);
  assert.equal(run!.detail.detailPending, 2);
  assert.deepEqual(run!.detail.detailErrors, []);
  assert.match(run!.detail.detailBudgetError, /exhausted \(minute\)/);
  for (let i = 0; i < 2; i++) {
    // Let the stub's rolling minute expire without changing the configured limit.
    await sql`UPDATE receipt_attempts SET started_at=now()-interval '2 minutes' WHERE service='jina'`;
    assert.equal((await collectSource(id)).status, "ok");
  }
  const rows = await sql`SELECT published_at FROM articles WHERE source_id=${id}`;
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.published_at?.toISOString() === publishedAt));
  assert.equal(reads.filter(url => url.includes(id) && !url.endsWith("/listing")).length, 3);
  const [last] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(last!.detail.detailPending, 0);
  assert.equal(last!.detail.detailBudgetError, null);
});

test("shutdown during detail work escapes collection without recording source failures", async () => {
  await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='jina'`;
  const id = await source("shutdown");
  stopOnDetail = true;
  await assert.rejects(collectSource(id), { name: "AbortError" });
  assert.equal(reads.filter(url => url.includes(id) && !url.endsWith("/listing")).length, 1);
  const [run] = await sql`SELECT status,detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.status, "running", "shutdown does not commit a successful listing with fake detail errors");
  assert.equal(run!.detail, null);
  const [row] = await sql`SELECT fail_count,last_ok_at FROM sources WHERE id=${id}`;
  assert.equal(row!.fail_count, 0);
  assert.equal(row!.last_ok_at, null);
});
