// Failure cases: a detail budget strands the tail forever; a temporary detail failure is swallowed;
// known complete articles consume the budget again; a successful page without a date starves later
// articles forever; hot signals accidentally fetch article bodies.
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
const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  if (path.startsWith("/listing")) {
    res.end([0, 1, 2].map(i => `<article><a href="/detail/${path.slice(9)}-${i}">Read more</a></article>`).join(""));
    return;
  }
  reads.set(path, (reads.get(path) ?? 0) + 1);
  if (fail) { res.writeHead(503); res.end("Unavailable"); return; }
  res.setHeader("content-type", "text/html");
  res.end(`<html><body><article><h1>Verified title ${path}</h1>${path.includes("undated") ? "" : `<time datetime="${date}"></time>`}<p>${"Verified original article body. ".repeat(50)}</p></article></body></html>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

async function source(name: string, mode = "editorial") {
  const id = `detail-${T}-${name}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,config,cursor,next_fetch_at)
    VALUES (${id},${name},'web_list','T1',${mode},${sql.json({ url: `${base}/listing/${id}`, itemSelector: "article", linkSelector: "a",
      detail: { maxFetches: 1, titleSelector: "h1", titleAuthoritative: true, publishedAtSelector: "time", publishedAtAuthoritative: true } })},
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

test("successful detail pages without dates do not consume every later run's budget", async () => {
  const id = await source("undated");
  for (let i = 0; i < 4; i++) await collectSource(id);
  const saved = await rows(id);
  assert.ok(saved.every(r => r.title.startsWith("Verified title")));
  assert.ok(saved.every(r => r.published_at === null));
  assert.equal([...reads.entries()].filter(([url]) => url.includes(id)).reduce((sum, [, n]) => sum + n, 0), 3);
});
