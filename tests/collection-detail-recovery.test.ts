// Failure cases: a detail budget strands the tail forever; a temporary detail failure is swallowed;
// known complete articles consume the budget again; a successful page without a date starves later
// articles forever; a page larger than the response limit fails on every run; hot signals
// accidentally fetch article bodies; a page the site refuses (paywall, captcha, blocked address) is read
// again on every run, taking the budget from the entries behind it; a page that keeps failing with a
// recoverable error is read on every run for days (a challenge page, HN buzzing 2026-10-18: one page
// 47 times in two days), or is given up and never recovers (a Qoder post went online 25 hours late).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
const date = new Date(Date.now() - 60_000).toISOString();
const reads = new Map<string, number>();
let fail = false;
let refuse = 0;
const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  if (path.startsWith("/listing")) {
    res.end([0, 1, 2].map(i => `<article><a href="/detail/${path.slice(9)}-${i}">Read more</a></article>`).join(""));
    return;
  }
  reads.set(path, (reads.get(path) ?? 0) + 1);
  if (fail) { res.writeHead(503); res.end("Unavailable"); return; }
  if (refuse && path.endsWith("-0")) { res.writeHead(refuse); res.end("Verify you are human"); return; }
  res.setHeader("content-type", "text/html");
  // A long paper with inline figures: larger than any response limit, its byline at the top.
  const figures = path.includes("oversized") ? `<p>${"figure ".repeat(1_500_000)}</p>` : "";
  res.end(`<html><body><article><h1>Verified title ${path}</h1>${path.includes("undated") ? "" : `<time datetime="${date}"></time>`}<p>${"Verified original article body. ".repeat(50)}</p>${figures}</article></body></html>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

async function source(name: string, mode = "editorial", maxFetches = 1) {
  const id = `detail-${T}-${name}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,config,cursor,next_fetch_at)
    VALUES (${id},${name},'web_list','T1',${mode},${sql.json({ url: `${base}/listing/${id}`, itemSelector: "article", linkSelector: "a",
      detail: { maxFetches, titleSelector: "h1", titleAuthoritative: true, publishedAtSelector: "time", publishedAtAuthoritative: true } })},
      ${sql.json({ initializedAt: new Date().toISOString() })},'2100-01-01')`;
  return id;
}
const rows = (id: string) => sql`SELECT title,published_at,body_text,revision FROM articles WHERE source_id=${id} ORDER BY url`;
const detail = async (id: string) => (await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`)[0]!.detail;

test("later listing runs fill missing detail fields left beyond the existing budget", async () => {
  const id = await source("budget");
  assert.equal((await collectSource(id)).created, 3);
  assert.equal((await rows(id)).filter(r => r.published_at).length, 1);
  await collectSource(id);
  await collectSource(id);
  const complete = await rows(id);
  assert.equal(complete.filter(r => r.published_at).length, 3);
  assert.ok(complete.every(r => r.title.startsWith("Verified title")));
  assert.ok(complete.every(r => r.body_text?.includes("Verified original article body")));
  const before = [...reads.values()].reduce((a, b) => a + b, 0);
  const repeat = await collectSource(id);
  assert.equal(repeat.revised, 0);
  assert.equal([...reads.values()].reduce((a, b) => a + b, 0), before, "complete articles are not read again");
});

test("a failed detail read stays observable and can recover on a later listing run", async () => {
  const id = await source("failure", "hot_signal");
  fail = true;
  try {
    assert.equal((await collectSource(id)).status, "ok", "the successful listing is retained");
    const failed = await detail(id);
    assert.equal(failed.detailAttempts, 1);
    assert.equal(failed.detailFailures, 1);
    assert.match(failed.detailErrors[0].error, /503/);
    assert.match(failed.detailErrors[0].url, /detail/);
  } finally { fail = false; }
  await collectSource(id);
  assert.equal((await rows(id)).filter(r => r.published_at).length, 1);
  assert.ok((await rows(id)).every(r => r.body_text === null), "hot signals do not gain extracted bodies");
  assert.equal((await detail(id)).detailFailures, 0);
});

test("a page the site refuses is reported once and not read again; the entries behind it get the budget", async () => {
  for (const status of [402, 403, 468]) {
    const id = await source(`refused-${status}`, "hot_signal");
    refuse = status;
    try {
      await collectSource(id);
      const first = await detail(id);
      assert.equal(first.detailFailures, 1);
      assert.match(first.detailErrors[0].error, new RegExp(String(status)));
      await collectSource(id);
      await collectSource(id);
    } finally { refuse = 0; }
    assert.equal(reads.get(`/detail/${id}-0`), 1, "the refused page is not bought again");
    assert.equal((await detail(id)).detailFailures, 0);
    const dated = await sql`SELECT url FROM articles WHERE source_id=${id} AND published_at IS NOT NULL ORDER BY url`;
    assert.deepEqual(dated.map(r => r.url.slice(-2)), ["-1", "-2"], "the refused entry keeps no date; the others get theirs");
  }
});

test("successful detail pages without dates do not consume every later run's budget", async () => {
  const id = await source("undated");
  for (let i = 0; i < 4; i++) await collectSource(id);
  const saved = await rows(id);
  assert.ok(saved.every(r => r.title.startsWith("Verified title")));
  assert.ok(saved.every(r => r.published_at === null));
  assert.equal([...reads.entries()].filter(([url]) => url.includes(id)).reduce((sum, [, n]) => sum + n, 0), 3);
});

test("a refused entry excluded by the publication boundary is not read again after a day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const id = await source("refused-excluded", "hot_signal", 3);
  await sql`UPDATE sources SET config = config || ${sql.json({ publishedAfter: new Date(Date.now() + 3600_000).toISOString() })} WHERE id=${id}`;
  refuse = 403;
  try {
    await collectSource(id);
    t.mock.timers.tick(24 * 3600_000);
    await collectSource(id);
    assert.equal(reads.get(`/detail/${id}-0`), 1, "expiry of a date check cannot revive an explicit access refusal");
    assert.equal((await rows(id)).length, 0);
  } finally { refuse = 0; }
});

test("a detail page larger than the response limit is read once up to the limit, without a cut-off body", async () => {
  const id = await source("oversized");
  for (let i = 0; i < 3; i++) await collectSource(id);
  assert.equal((await detail(id)).detailFailures, 0);
  const saved = await rows(id);
  assert.ok(saved.every(r => r.title.startsWith("Verified title") && r.published_at?.toISOString() === date));
  assert.ok(saved.every(r => r.body_text === null), "a body cut at the limit is not stored");
  const readsOf = () => [...reads.entries()].filter(([url]) => url.includes(id)).reduce((sum, [, n]) => sum + n, 0);
  assert.equal(readsOf(), 3);
  await collectSource(id);
  assert.equal(readsOf(), 3, "the page is not read again");
});

test('recoverable errors at the front cannot consume every later detail budget', async () => {
  for (const status of [404, 429, 503]) {
    const id = await source(`retry-tail-${status}`, 'hot_signal');
    refuse = status;
    try {
      for (let run = 0; run < 3; run++) await collectSource(id);
      const dated = await sql`SELECT url FROM articles WHERE source_id=${id} AND published_at IS NOT NULL ORDER BY url`;
      assert.deepEqual(dated.map(r => r.url.slice(-2)), ['-1', '-2'], `${status}: later entries must be reached before retrying the first`);
      assert.equal(reads.get(`/detail/${id}-0`), 1);
      await collectSource(id);
      assert.equal(reads.get(`/detail/${id}-0`), 2, 'a transient error remains eligible for recovery');
    } finally { refuse = 0; }
    await collectSource(id);
    assert.equal((await rows(id)).filter(r => r.published_at).length, 3, 'the failed entry still recovers');
  }
});

test("a page that keeps failing is read less and less often, never given up, and recovers", async (t) => {
  const HOUR = 3_600_000;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const id = await source("backoff", "hot_signal", 3);
  const readsOf = () => reads.get(`/detail/${id}-0`) ?? 0;
  refuse = 503;
  try {
    for (let run = 0; run < 4; run++) await collectSource(id);
    assert.equal(readsOf(), 3, "three straight tries, then it waits");
    const waiting = await detail(id);
    assert.equal(waiting.detailFailures, 0, "a page waiting for its next try is not another failure");
    assert.equal(waiting.detailPending, 1);
    t.mock.timers.tick(HOUR);
    await collectSource(id);
    await collectSource(id);
    assert.equal(readsOf(), 4, "an hour later it is tried once, then waits longer");
    t.mock.timers.tick(HOUR);
    await collectSource(id);
    assert.equal(readsOf(), 4, "the second wait is two hours");
    t.mock.timers.tick(HOUR);
    await collectSource(id);
    assert.equal(readsOf(), 5);
    for (let day = 0; day < 4; day++) {
      t.mock.timers.tick(24 * HOUR);
      await collectSource(id);
    }
    assert.equal(readsOf(), 9, "the wait stops growing at a day: the page is never given up");
  } finally { refuse = 0; }
  t.mock.timers.tick(24 * HOUR);
  await collectSource(id);
  assert.equal(readsOf(), 10);
  assert.equal((await rows(id)).filter(r => r.published_at).length, 3, "the page recovers");
  await collectSource(id);
  assert.equal(readsOf(), 10, "a recovered page is not read again");
});
