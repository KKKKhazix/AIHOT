// Collection picks up where it stopped: an X search longer than one run continues in later runs until
// it meets the old watermark (no post in between is skipped, no page is bought twice). The watermark
// alone bounds it: posts made weeks before the account was added are kept too.
import { gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { upsertMaterial, identityKeyFor } from "@aihot/backend/content/materials";
import { collectFindings } from "@aihot/backend/operations/alerts";

const T = tag();
const X_SOURCE = `test-x-${T}`;

// SocialData: 45 posts newer than the watermark, newest first half a day apart, 2 a page; `cursor` is the page number.
const BASE = BigInt(Date.now()) * 1000n;
const WATERMARK = BASE + 100n;
const POSTS = Array.from({ length: 45 }, (_, i) => BASE + 145n - BigInt(i));
const tweet = (id: bigint) => ({
  id_str: String(id), tweet_created_at: new Date(Date.now() - Number(BASE + 145n - id) * 12 * 3_600_000).toISOString(),
  full_text: `Post ${id} ${T}`, lang: "en", user: { name: "Test account", screen_name: `acct${T}` },
});
let heldResponse: (() => Promise<unknown>) | null = null;
const socialdata = await stub(async (_hit, req) => {
  if (heldResponse) return heldResponse();
  const u = new URL(req.url, "http://stub");
  const since = BigInt(/since_id:(\d+)/.exec(u.searchParams.get("query") ?? "")?.[1] ?? "0");
  const page = Number(u.searchParams.get("cursor") ?? 0);
  const ids = POSTS.filter((id) => id > since);
  return { tweets: ids.slice(page * 2, page * 2 + 2).map(tweet), next_cursor: (page + 1) * 2 < ids.length ? String(page + 1) : null };
});

process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${X_SOURCE}, 'Test X', 'x_search', ${sql.json({ query: `from:acct${T}` })}, 'T1', 'editorial',
                    ${sql.json({ initializedAt: new Date().toISOString(), lastTweetId: String(WATERMARK) })}, '2100-01-01')`;
});
after(async () => {
  await socialdata.close();
  for (const server of [bodyServer, titleServer, detailServer, identityServer, tailServer]) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await stopBoss();
  await closeDb();
});

test("an X search longer than one run is read to the old watermark over the next runs", async () => {
  const stored = async () => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = ${X_SOURCE}`)[0]!.n);
  const cursor = async () => (await sql<{ cursor: { lastTweetId: string; xBacklog?: unknown[] } }[]>`SELECT cursor FROM sources WHERE id = ${X_SOURCE}`)[0]!.cursor;

  const first = await collectSource(X_SOURCE, { force: true });
  assert.equal(first.status, "ok");
  assert.equal(await stored(), 40, "a run reads its own pages and ten more of the stretch left over");
  assert.equal((await cursor()).lastTweetId, String(BASE + 145n), "the watermark moves to the newest post");
  assert.equal((await cursor()).xBacklog?.length, 1, "the unread stretch is kept for the next run");
  const [run] = await sql<{ detail: { truncated: boolean; backlog: number } }[]>`SELECT detail FROM fetch_runs WHERE source_id = ${X_SOURCE} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([run!.detail.truncated, run!.detail.backlog], [true, 1], "the admin sees the stretch still to read");

  const receipts = await sql`SELECT status FROM receipts WHERE service = 'socialdata' AND subject = ${`source:${X_SOURCE}`}`;
  assert.equal(receipts.length, 20);
  assert.ok(receipts.every((r) => r.status === "completed"), "stored pages complete with the saved coverage, including backlog pages");

  const second = await collectSource(X_SOURCE, { force: true });
  assert.equal(second.status, "ok");
  assert.equal(await stored(), 45, "every post between the old watermark and the newest is stored");
  assert.equal((await cursor()).xBacklog, undefined, "nothing is left to read");
  assert.equal(socialdata.hits(), 20 + 1 + 3, "no page is requested twice");
});

test("a stretch left over for days is given up instead of bought again", async () => {
  const stale = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const query = `from:acct${T} since_id:${BASE + 1n}`;
  await sql`UPDATE sources SET cursor = cursor || ${sql.json({ xBacklog: [{ query, next: "0", at: stale }] })}
            WHERE id = ${X_SOURCE}`;
  const res = await collectSource(X_SOURCE, { force: true });
  assert.equal(res.status, "ok");
  const [kept] = await sql<{ cursor: { xBacklog?: unknown[] } }[]>`SELECT cursor FROM sources WHERE id = ${X_SOURCE}`;
  assert.equal(kept!.cursor.xBacklog, undefined, "the old stretch is not kept");
  const paid = await sql`SELECT id FROM receipts WHERE request->>'query' = ${query}`;
  assert.equal(paid.length, 0, "the old stretch's page is not requested again");
  const [run] = await sql<{ detail: { dropped: number } }[]>`SELECT detail FROM fetch_runs WHERE source_id = ${X_SOURCE} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.detail.dropped, 1, "the admin sees the stretch given up");
});

test("finishing an in-flight collection cannot overwrite a source's paused state", async () => {
  for(const failed of [false,true]) {
    const id=`paused-${failed}-${T}`,entered=gate(),release=gate();
    await sql`INSERT INTO sources(id,name,kind,config) VALUES(${id},${id},'x_search',${sql.json({query:`from:paused${failed}${T}`})})`;
    heldResponse=async()=>{entered.open();await release.promise;return failed?new Reply(400,{error:"refused source"}):{tweets:[]};};
    try {
      const collecting=collectSource(id,{force:true});
      await entered.promise;
      await sql`UPDATE sources SET enabled=false,health='paused' WHERE id=${id}`;
      release.open();
      assert.equal((await collecting).status,failed?'failed':'ok');
      assert.equal((await sql`SELECT health FROM sources WHERE id=${id}`)[0]!.health,'paused');
    } finally {release.open();heldResponse=null;}
  }
});

// Metadata recovery must not replace an already confirmed article body with another rendering of
// the page; the same free detail response can still supply a body when none was confirmed before.

const original = "The publisher already supplied this confirmed body, which must remain unchanged. ".repeat(6).trim();
const alternate = "A later page rendering supplies different readable text while exposing its publication metadata. ".repeat(6).trim();
const bodyPublishedAt = new Date(Date.now() - 3600000);
const presentationNames = ["blocked", "later"];
let presentationMarkup = "<p>The <b>model</b> is available.</p>";
const bodyServer = http.createServer((req, res) => {
  if (req.url === "/presentation-feed") {
    res.setHeader("content-type", "application/rss+xml");
    return res.end(`<rss version="2.0"><channel><title>Fixture</title>${presentationNames.map(name => `<item><title>${name}</title><link>${bodyBase}/${name}</link><pubDate>${bodyPublishedAt.toUTCString()}</pubDate><content:encoded><![CDATA[${name === "blocked" ? presentationMarkup : "<p>A second article can still be collected.</p>"} ]]></content:encoded></item>`).join("")}</channel></rss>`);
  }
  res.setHeader("content-type", "text/html");
  if (req.url === "/listing") return res.end(`<ul><li><a href="/complete">Complete article</a></li><li><a href="/pending">Pending article</a></li></ul>`);
  const title = req.url === "/complete" ? "Complete article" : "Pending article";
  res.end(`<html><head><title>${title}</title><meta property="article:published_time" content="${bodyPublishedAt.toISOString()}"></head><body><article><h1>${title}</h1><p>${alternate}</p></article></body></html>`);
});
await new Promise<void>((resolve) => bodyServer.listen(0, "127.0.0.1", resolve));
const bodyBase = `http://127.0.0.1:${(bodyServer.address() as { port: number }).port}`;

test("publication metadata recovery keeps a confirmed body and only fills an unconfirmed body", async () => {
  const sourceId = `body-preservation-${T}`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor) VALUES (${sourceId},'Body preservation','web_list',${sql.json({ url: bodyBase + "/listing", itemSelector: "li", titleSelector: "a", detail: { maxFetches: 10 } })},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })})`;
  const complete = await upsertMaterial({ sourceId, url: bodyBase + "/complete", title: "Complete article", bodyText: original, bodyHtml: `<p>${original}</p>`, bodyStatus: "ok", via: "fetch" });
  const pending = await upsertMaterial({ sourceId, url: bodyBase + "/pending", title: "Pending article", bodyStatus: "pending", via: "fetch" });
  assert.equal((await collectSource(sourceId)).status, "ok");
  const [confirmed] = await sql`SELECT body_text,body_html,body_status,published_at FROM articles WHERE id=${complete.articleId}`;
  assert.equal(confirmed!.body_text, original);
  assert.equal(confirmed!.body_html, `<p>${original}</p>`);
  assert.equal(confirmed!.body_status, "ok");
  assert.equal(confirmed!.published_at.toISOString(), bodyPublishedAt.toISOString());
  const [filled] = await sql`SELECT body_text,body_status,published_at FROM articles WHERE id=${pending.articleId}`;
  assert.ok(filled!.body_text.includes(alternate));
  assert.equal(filled!.body_status, "ok");
  assert.equal(filled!.published_at.toISOString(), bodyPublishedAt.toISOString());
});


test("an unmatchable translated layout stays intact, is not a follow-up and does not stop its feed", async () => {
  const sourceId = `presentation-blocked-${T}`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor) VALUES (${sourceId},'Presentation blocked','rss',${sql.json({ feedUrl: bodyBase + "/presentation-feed", summaryIsBody: true })},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })})`;
  const input = { sourceId, url: bodyBase + "/blocked", title: "blocked", bodyText: "The model is available.", bodyHtml: "<p>The model is available.</p>", bodyStatus: "ok" as const, via: "fetch" as const, publishedAt: bodyPublishedAt };
  const { articleId } = await upsertMaterial(input);
  await sql`INSERT INTO translations(article_id,lang,revision,body_html,body_text,complete,origin)
    VALUES (${articleId},'zh',1,'<p>模型已开放。</p>','模型已开放。',true,'model')`;
  await sql`UPDATE articles SET processing_state='analyzed',grouping_status='complete' WHERE id=${articleId}`;
  const result = await collectSource(sourceId);
  assert.equal(result.status, "ok");
  assert.equal(result.created, 1, "the article behind the failed refresh is still collected");
  const [row] = await sql`SELECT a.body_html,a.revision,a.processing_state,a.processing_error,t.body_html AS translated FROM articles a JOIN translations t ON t.article_id=a.id WHERE a.id=${articleId}`;
  assert.deepEqual({ ...row }, { body_html: input.bodyHtml, revision: 1, processing_state: 'analyzed', processing_error: null, translated: '<p>模型已开放。</p>' });
  // 10-19..10-29: all eight such follow-ups were the same wording with a link added or tags nested
  // differently, closed as accepted; the consistent version kept is the answer, there is nothing to do.
  assert.equal((await collectFindings()).some(f => f.key.startsWith("sources.") && f.key.endsWith(`.${sourceId}`)), false);
  presentationMarkup = '<p>The model is available.</p><figure><img src="https://example.com/restored.png"></figure>';
  assert.equal((await collectSource(sourceId)).status, "ok");
  assert.match((await sql`SELECT body_html FROM articles WHERE id=${articleId}`)[0]!.body_html, /restored.png/, "a layout the translation can follow is applied");
});

// Failures: a listing's CTA masks a new title, or changing its detail rendering causes a known real
// headline over 100 characters to buy another paid read. An explicit authoritative rule still wins.

const longTitle = "Protections from model supply chain attacks are inherently flawed, but Aim Labs' new generation of scanners bridges the gaps";
const titlePublishedAt = new Date(Date.now() - 3600000);
const detailReads: string[] = [];
const urls = Object.fromEntries(["known", "new", "forced"].map(name => [name, `https://publisher.example/article-${name}-${T}`]));
const titles = { known: longTitle, new: "A newly published research result", forced: "The authoritative corrected headline" };
const titleServer = http.createServer((req, res) => {
  const target = req.url!.slice(1);
  const name = ["known", "new", "forced"].find(name => target.endsWith(`-${name}-${T}`))!;
  const listing = target.includes("/list-");
  if (!listing) detailReads.push(name);
  res.setHeader("content-type", "text/plain");
  res.end(`Title: A page\nURL Source: ${target}\nPublished Time: ${titlePublishedAt.toISOString()}\nMarkdown Content:\n` +
    (listing ? `[Read the Blog](${urls[name]})` : `# ${titles[name as keyof typeof titles]}\n\nA publisher-supplied article.`));
});
await new Promise<void>((resolve) => titleServer.listen(0, "127.0.0.1", resolve));
process.env.JINA_BASE_URL = `http://127.0.0.1:${(titleServer.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-key";
before(async () => {
  await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='jina'`;
  for (const name of ["known", "new", "forced"] as const) {
    const id = `title-recovery-${name}-${T}`;
    const sourceConfig = { url: `https://r.jina.ai/https://publisher.example/list-${name}-${T}`, parseMode: "markdown", detail: {
      maxFetches: 5, titleRegex: "^#\\s+(.+)$", publishedAtRegex: "Published Time:\\s*(\\S+)", ...(name === "forced" ? { titleAuthoritative: true } : {}),
    } };
    await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor) VALUES (${id},'Title recovery','web_list',${sql.json(sourceConfig)},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })})`;
    if (name !== "new") await upsertMaterial({ sourceId: id, url: urls[name]!, title: longTitle, publishedAt: titlePublishedAt, via: "fetch" });
  }
});

test("a known real headline does not buy a new detail read merely because it is long and the listing says Read the Blog", async () => {
  assert.equal((await collectSource(`title-recovery-known-${T}`)).status, "ok");
  assert.deepEqual(detailReads, []);
  const [article] = await sql`SELECT title,revision FROM articles WHERE url=${urls.known!}`;
  assert.equal(article!.title, longTitle);
  assert.equal(article!.revision, 1);
});

test("a new CTA obtains its title and date from one existing detail rendering path, and does not reread on the next run", async () => {
  const before = detailReads.length;
  const id = `title-recovery-new-${T}`;
  assert.equal((await collectSource(id)).status, "ok");
  assert.equal(detailReads.length - before, 1);
  const [article] = await sql`SELECT title,published_at FROM articles WHERE url=${urls.new!}`;
  assert.equal(article!.title, titles.new);
  assert.equal(article!.published_at.toISOString(), titlePublishedAt.toISOString());
  assert.equal((await collectSource(id)).status, "ok");
  assert.equal(detailReads.length - before, 1);
});

test("an explicit authoritative title rule still replaces a known headline", async () => {
  const before = detailReads.length;
  assert.equal((await collectSource(`title-recovery-forced-${T}`)).status, "ok");
  assert.equal(detailReads.length - before, 1);
  const [article] = await sql`SELECT title FROM articles WHERE url=${urls.forced!}`;
  assert.equal(article!.title, titles.forced);
});

// Failure cases: a detail budget strands the tail forever; a temporary detail failure is swallowed;
// known complete articles consume the budget again; a successful page without a date starves later
// articles forever; a page larger than the response limit fails on every run; hot signals
// accidentally fetch article bodies; a page the site refuses (paywall, captcha, blocked address) is read
// again on every run, taking the budget from the entries behind it; a page that keeps failing with a
// recoverable error is read on every run for days (a challenge page, HN buzzing 2026-10-18: one page
// 47 times in two days), or is given up and never recovers (a Qoder post went online 25 hours late).

const date = new Date(Date.now() - 60_000).toISOString();
const reads = new Map<string, number>();
let fail = false;
let refuse = 0;
const detailServer = http.createServer((req, res) => {
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
await new Promise<void>(resolve => detailServer.listen(0, "127.0.0.1", resolve));
const detailBase = `http://127.0.0.1:${(detailServer.address() as { port: number }).port}`;

async function detailSource(name: string, mode = "editorial", maxFetches = 1) {
  const id = `detail-${T}-${name}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,config,cursor,next_fetch_at)
    VALUES (${id},${name},'web_list','T1',${mode},${sql.json({ url: `${detailBase}/listing/${id}`, itemSelector: "article", linkSelector: "a",
      detail: { maxFetches, titleSelector: "h1", titleAuthoritative: true, publishedAtSelector: "time", publishedAtAuthoritative: true } })},
      ${sql.json({ initializedAt: new Date().toISOString() })},'2100-01-01')`;
  return id;
}
const rows = (id: string) => sql`SELECT title,published_at,body_text,revision FROM articles WHERE source_id=${id} ORDER BY url`;
const detail = async (id: string) => (await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`)[0]!.detail;

test("later listing runs fill missing detail fields left beyond the existing budget", async () => {
  const id = await detailSource("budget");
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
  const id = await detailSource("failure", "hot_signal");
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

// 10-20..11-01: every "详情补全失败" follow-up left after the fixes was HN links to sites refusing us
// (401/403/419), closed as accepted each week; the site's answer is final, nothing of ours failed.
test("a page the site refuses is recorded once, not counted as a failure and not read again; the entries behind it get the budget", async () => {
  for (const status of [402, 403, 468]) {
    const id = await detailSource(`refused-${status}`, "hot_signal");
    refuse = status;
    try {
      await collectSource(id);
      const first = await detail(id);
      assert.equal(first.detailFailures, 0);
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
  const id = await detailSource("undated");
  for (let i = 0; i < 4; i++) await collectSource(id);
  const saved = await rows(id);
  assert.ok(saved.every(r => r.title.startsWith("Verified title")));
  assert.ok(saved.every(r => r.published_at === null));
  assert.equal([...reads.entries()].filter(([url]) => url.includes(id)).reduce((sum, [, n]) => sum + n, 0), 3);
});

test("a refused entry excluded by the publication boundary is not read again after a day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const id = await detailSource("refused-excluded", "hot_signal", 3);
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
  const id = await detailSource("oversized");
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
    const id = await detailSource(`retry-tail-${status}`, 'hot_signal');
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
  const id = await detailSource("backoff", "hot_signal", 3);
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

// Failure cases: tracking aliases miss the stored article, duplicate cards buy duplicate detail
// requests, fragment-aware HTML lists collapse separate updates, a podcast episode linked to its media
// file changes identity or sends the file to page extraction.

let detailHits = 0;
let campaign = "first";
const identityServer = http.createServer((req, res) => {
  const path = req.url!;
  if (path === "/podcast.xml") {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(`<rss version="2.0"><channel><title>Show</title>${Object.entries(EPISODES).map(([n, tags]) =>
      `<item><title>Episode ${n}</title>${tags}<pubDate>${new Date().toUTCString()}</pubDate></item>`).join("")}</channel></rss>`);
  } else if (path.startsWith("/post")) {
    detailHits++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><head><title>Detail</title></head><body><h1>Actual headline</h1></body></html>');
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(path === "/sections.md" ? `[First update](${identityBase}/sections.md#one)\n[Second update](${identityBase}/sections.md#two)` :
      path === "/sections" ? '<a href="#one">First update</a><a href="#two">Second update</a>' :
      Array.from({ length: 10 }, (_, i) => `<a href="/post?utm_source=${campaign}${i}">Read more</a>`).join(""));
  }
});
await new Promise<void>(resolve => identityServer.listen(0, "127.0.0.1", resolve));
const identityBase = `http://127.0.0.1:${(identityServer.address() as { port: number }).port}`;
const audio = (n: number) => `<enclosure url="${identityBase}/episodes/${n}.mp3" type="audio/mpeg" length="1"/>`;
// No page (a guid that is no address), a page link, an address guid, and neither page nor media file.
const EPISODES: Record<number, string> = {
  1: `<guid isPermaLink="false">Buzzsprout-1</guid>${audio(1)}`,
  2: `<link>https://example.org/episodes/2</link><guid isPermaLink="false">Buzzsprout-2</guid>${audio(2)}`,
  3: `<guid>https://example.org/episodes/3</guid>${audio(3)}`,
  4: `<guid isPermaLink="false">Buzzsprout-4</guid>`,
};
async function identitySource(kind: string, settings: Record<string, unknown>) {
  const id = `identity-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,config,cursor) VALUES (${id},'Identity test',${kind},${sql.json(settings as never)},${sql.json({ initializedAt: new Date().toISOString() })})`;
  return id;
}

test("detail enrichment shares material identity across duplicate cards and changing tracking parameters", async () => {
  const id = await identitySource("web_list", { url: `${identityBase}/listing`, detail: { titleSelector: "h1", maxFetches: 10 } });
  assert.equal((await collectSource(id)).created, 1);
  const firstHits = detailHits;
  campaign = "second";
  const result = await collectSource(id);
  assert.equal(firstHits, 1, "one article needs only one detail request even when ten cards link to it");
  assert.equal(result.status, "ok");
  assert.equal(result.revised, 0);
  assert.equal(detailHits, 1, "stored identity reuses the confirmed title without another detail request");
  const [row] = await sql`SELECT title,revision FROM articles WHERE source_id=${id}`;
  assert.deepEqual({ ...row }, { title: "Actual headline", revision: 1 });
});

for (const parseMode of ["html", "markdown"]) test(`${parseMode} sections explicitly configured as posts retain distinct identities`, async () => {
  const id = await identitySource("web_list", { url: `${identityBase}/sections${parseMode === "markdown" ? ".md" : ""}`, parseMode, preserveUrlFragment: true });
  assert.equal((await collectSource(id)).created, 2);
  assert.equal((await collectSource(id)).revised, 0);
  const rows = await sql`SELECT url,revision FROM articles WHERE source_id=${id} ORDER BY url`;
  assert.deepEqual(rows.map(r => [String(r.url).split("#")[1], r.revision]), [["one", 1], ["two", 1]]);
});

test("a podcast episode without a page links to its media file, keeps its guid's identity and is not sent to fetch a page", async () => {
  const id = await identitySource("rss", { feedUrl: `${identityBase}/podcast.xml` });
  assert.equal((await collectSource(id)).created, 4);
  const rows = await sql`SELECT a.identity_key,a.url,a.title,a.body_status,j.name AS job FROM articles a
    LEFT JOIN pgboss.job j ON j.data->>'articleId'=a.id WHERE a.source_id=${id} ORDER BY a.title`;
  assert.deepEqual(rows.map(r => r.url), [`${identityBase}/episodes/1.mp3`, "https://example.org/episodes/2", "https://example.org/episodes/3", "Buzzsprout-4"],
    "a page link or an address guid still wins; without page or media file the guid stays");
  const [episode] = rows;
  assert.equal(episode!.identity_key, identityKeyFor({ sourceId: id, url: "Buzzsprout-1", title: "Episode 1", via: "fetch" }), "the identity an episode stored under its guid had");
  assert.deepEqual([episode!.body_status, episode!.job], ["none", QUEUES.analyze], "judged on the feed: the media file is no page to extract");
  assert.equal((await collectSource(id)).created, 0);
});

// A regular run keeps every entry published since its source was added, past the first 60: the cursor (an
// RSS validator) moves past the whole listing. The dated archive from before comes in only through the
// bounded first import; the success cursor keeps its bound.

type Kind = "rss" | "json_list" | "web_list";
interface Item { url: string; title: string; date: string | null; summary: string; category?: string }
interface Listing {
  kind: Kind;
  items: Item[];
  version: number;
  requests: Array<{ etag?: string; status: number }>;
}
const listings = new Map<string, Listing>();
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const tailServer = http.createServer((req, res) => {
  const path = req.url ?? "/";
  const listing = listings.get(path);
  if (!listing) { res.writeHead(404); res.end(); return; }
  const etag = `"v${listing.version}"`;
  const status = listing.kind === "rss" && req.headers["if-none-match"] === etag ? 304 : 200;
  listing.requests.push({ etag: req.headers["if-none-match"], status });
  if (status === 304) { res.writeHead(304, { etag }); res.end(); return; }
  if (listing.kind === "json_list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listing.items));
  } else if (listing.kind === "web_list") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(listing.items.map(i => `<article><a href="${escape(i.url)}">${escape(i.title)}</a>${i.date ? `<time datetime="${i.date}"></time>` : ""}</article>`).join(""));
  } else {
    res.writeHead(200, { "content-type": "application/rss+xml", etag });
    res.end(`<rss version="2.0"><channel><title>测试订阅</title>${listing.items.map(i =>
      `<item><title>${escape(i.title)}</title><link>${escape(i.url)}</link>${i.date ? `<pubDate>${new Date(i.date).toUTCString()}</pubDate>` : ""}<description>${escape(i.summary)}</description><category>${escape(i.category ?? "keep")}</category></item>`).join("")}</channel></rss>`);
  }
});
await new Promise<void>(resolve => tailServer.listen(0, "127.0.0.1", resolve));
const tailBase = `http://127.0.0.1:${(tailServer.address() as { port: number }).port}`;

function items(name: string, count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `${tailBase}/article/${T}-${name}/${i}`, title: `测试文章 ${name} ${i}`, date: new Date(Date.now() - i * 1000).toISOString(), summary: `摘要 ${name} ${i}`,
  }));
}
async function tailSource(name: string, kind: Kind, rows: Item[], extra: Record<string, unknown> = {}, initialized = true) {
  const id = `tail-${T}-${name}`;
  const path = `/listing/${id}`;
  const listing: Listing = { kind, items: rows, version: 1, requests: [] };
  listings.set(path, listing);
  const mapping = kind === "rss" ? { feedUrl: tailBase + path } : kind === "json_list"
    ? { url: tailBase + path, titlePaths: ["title"], urlTemplate: "{raw:url}", publishedAtPath: "date", summaryPaths: ["summary"], summaryIsBody: true }
    : { url: tailBase + path, itemSelector: "article", linkSelector: "a", publishedAtSelector: "time" };
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'列表尾部测试',${kind},${sql.json({ ...mapping, ...extra } as never)},'T1','editorial',
      ${initialized ? sql.json({ initializedAt: new Date().toISOString() }) : null},'2100-01-01')`;
  return { id, listing };
}
const count = async (id: string) => (await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${id}`)[0]!.n as number;
const cursor = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;
const jobs = async (id: string) => (await sql`SELECT count(*)::int AS n FROM pgboss.job j JOIN articles a ON a.id=j.data->>'articleId' WHERE a.source_id=${id}`)[0]!.n as number;
const revisions = async (id: string) => (await sql`SELECT count(*)::int AS n FROM article_revisions r JOIN articles a ON a.id=r.article_id WHERE a.source_id=${id}`)[0]!.n as number;

test("a future entry behind a publication boundary is collected when due without a feed change", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: now - 2 * 3600000 });
  const rows = items("future-boundary", 1);
  rows[0]!.date = new Date(Math.floor(now / 1000) * 1000 - 60000).toISOString();
  const { id, listing } = await tailSource("future-boundary", "rss", rows, {
    publishedAfter: new Date(Date.now() - 86400000).toISOString(),
  });
  assert.equal((await collectSource(id)).created, 0, "an early listing must wait for its publication time");
  t.mock.timers.tick(2 * 3600000);
  assert.equal((await collectSource(id)).created, 1, "an unchanged feed must not freeze the deferred entry out");
  assert.equal((await collectSource(id)).found, 0, "conditional requests resume after the entry is admitted");
  assert.deepEqual(listing.requests.map(r => r.status), [200, 200, 304]);
  assert.equal(await count(id), 1);
  const [article] = await sql`SELECT published_at,backfill FROM articles WHERE source_id=${id}`;
  assert.equal(article!.published_at.toISOString(), rows[0]!.date);
  assert.equal(article!.backfill, false);
});

test("the 61st entry of a known feed is stored before its validator answers 304", async () => {
  const { id, listing } = await tailSource("rss", "rss", items("rss", 61));
  const first = await collectSource(id);
  assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", 61, 61, 0]);
  assert.equal(await count(id), 61);
  assert.equal((await cursor(id)).rss.etag, '"v1"');
  const beforeJobs = await jobs(id);
  const second = await collectSource(id);
  assert.deepEqual([second.status, second.found, second.created, second.revised], ["ok", 0, 0, 0]);
  assert.deepEqual(listing.requests, [{ etag: undefined, status: 200 }, { etag: '"v1"', status: 304 }]);
  assert.equal(await count(id), 61);
  assert.equal(await revisions(id), 61);
  assert.equal(await jobs(id), beforeJobs);
});

for (const size of [0, 61]) {
  test(`a regular JSON run keeps all ${size} entries it was given`, async () => {
    const { id } = await tailSource(`size-${size}`, "json_list", items(`size-${size}`, size));
    const result = await collectSource(id);
    assert.deepEqual([result.status, result.found, result.created, result.revised], ["ok", size, size, 0]);
    assert.equal(await count(id), size);
  });
}

test("a listing longer than a query's parameter limit is still deduplicated and its new tail stored", async () => {
  const known: Item = { url: `${tailBase}/${T}`, title: "Large", date: null, summary: "" };
  const tail = { ...known, url: known.url + "-tail", title: "Tail" };
  const { id, listing } = await tailSource("large", "json_list", [known]);
  assert.equal((await collectSource(id)).created, 1);
  listing.items = [...Array<Item>(65_535).fill(known), tail];
  assert.ok(Buffer.byteLength(JSON.stringify(listing.items)) < 8 * 1024 * 1024, "the response stays within the 8 MiB limit");
  const result = await collectSource(id);
  assert.deepEqual(result, { sourceId: id, status: "ok", found: 65_536, created: 1, revised: 0 });
  assert.equal(await count(id), 2);
  assert.equal(await revisions(id), 2);
  assert.equal(await jobs(id), 2);
  assert.deepEqual(await collectSource(id), { sourceId: id, status: "ok", found: 65_536, created: 0, revised: 0 });
  assert.equal(await revisions(id), 2);
  assert.equal(await jobs(id), 2);
});

test("with the first 60 known, the tail is still created and revised, and queued for processing once", async () => {
  const rows = items("json-tail", 61);
  const { id, listing } = await tailSource("json-tail", "json_list", rows.slice(0, 60));
  assert.equal((await collectSource(id)).created, 60);
  listing.items = rows;
  const added = await collectSource(id);
  assert.deepEqual([added.status, added.found, added.created, added.revised], ["ok", 61, 1, 0]);
  const [tail] = await sql`SELECT id,revision FROM articles WHERE url=${rows[60]!.url}`;
  assert.equal(tail!.revision, 1);
  // The first job is done: the revision must queue processing again.
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=${tail!.id}`;
  await sql`UPDATE articles SET processing_queued_at=NULL WHERE id=${tail!.id}`;
  rows[60] = { ...rows[60]!, title: "尾部修订后的标题", summary: "尾部修订后的正文" };
  const revised = await collectSource(id);
  assert.deepEqual([revised.status, revised.created, revised.revised], ["ok", 0, 1]);
  const [saved] = await sql`SELECT title,body_text,revision,processing_queued_at FROM articles WHERE id=${tail!.id}`;
  assert.deepEqual([saved!.title, saved!.body_text, saved!.revision], [rows[60]!.title, rows[60]!.summary, 2]);
  assert.ok(saved!.processing_queued_at);
  const [job] = await sql`SELECT name FROM pgboss.job WHERE data->>'articleId'=${tail!.id}`;
  assert.equal(job!.name, QUEUES.analyze);
  const beforeJobs = await jobs(id);
  assert.deepEqual(await collectSource(id), { sourceId: id, status: "ok", found: 61, created: 0, revised: 0 });
  assert.equal(await count(id), 61);
  assert.equal(await revisions(id), 62);
  assert.equal(await jobs(id), beforeJobs);
});

for (const reverse of [false, true]) {
  test(`a web list of 61 entries loses none, ${reverse ? "oldest" : "newest"} first`, async () => {
    const rows = items(`web-${reverse}`, 61);
    if (reverse) rows.reverse();
    const { id, listing } = await tailSource(`web-${reverse}`, "web_list", rows, { sortByPublishedAt: reverse });
    const result = await collectSource(id);
    assert.deepEqual([result.status, result.found, result.created], ["ok", 61, 61]);
    assert.equal(await count(id), 61);
    assert.equal(listing.requests.length, 1, "the tail costs no extra listing request");
  });
}

test("the first import keeps its count and age limits; later runs take what was published since, and undated entries, before accepting 304", async () => {
  const rows = items("initial", 100);
  rows[0]!.date = new Date(Date.now() - 400 * 86400000).toISOString();
  // Past the import's count: published days before the source is added, just within the stale window, undated.
  for (const row of rows.slice(90, 95)) row.date = new Date(Date.now() - 3 * 86400000).toISOString();
  rows[95]!.date = new Date(Date.now() - 47 * 3600000).toISOString();
  for (const row of rows.slice(96)) row.date = null;
  const { id, listing } = await tailSource("initial", "rss", rows, { _aihot: { initialBackfillLimit: 7, initialBackfillMonths: 12 } }, false);
  assert.equal((await collectSource(id)).created, 7);
  assert.equal((await cursor(id)).rss, undefined);
  const imported = await sql`SELECT url,backfill,backfill_reason FROM articles WHERE source_id=${id}`;
  assert.ok(imported.every(a => a.backfill && a.backfill_reason === "first-import"));
  assert.ok(!imported.some(a => a.url === rows[0]!.url), "an entry past the age limit takes no place in the first import");
  const second = await collectSource(id);
  assert.deepEqual([second.status, second.found, second.created, second.revised], ["ok", 100, 87, 0]);
  const stored = await sql`SELECT url,backfill_reason FROM articles WHERE source_id=${id}`;
  const urls = new Set(stored.map(a => a.url));
  assert.deepEqual([0, 90, 91, 92, 93, 94].filter(i => urls.has(rows[i]!.url)), [], "what was published before the source was added stays out");
  assert.ok(urls.has(rows[95]!.url) && urls.has(rows[89]!.url), "what was published since is kept, however far down the listing");
  assert.deepEqual(stored.filter(a => rows.slice(96).some(r => r.url === a.url)).map(a => a.backfill_reason), Array(4).fill("unknown-publication-time"),
    "undated entries are kept and wait for a date");
  assert.equal(await count(id), 94);
  assert.equal((await collectSource(id)).found, 0);
  assert.deepEqual(listing.requests.map(r => r.status), [200, 200, 304]);
  assert.equal(listing.requests[1]!.etag, undefined);
});

// A corrected listing can reveal that an existing undated item is old. The archive admission rule
// must still reject a never-seen old item, while allowing metadata repair of the existing identity.
test("a listing repairs an existing old article without admitting a new old archive item", async () => {
  const kind = "rss";
  const known = { ...items(`repair-${kind}`, 1)[0]!, date: null };
  const { id, listing } = await tailSource(`repair-${kind}`, kind, [known]);
  assert.equal((await collectSource(id)).created, 1);
  const oldDate = new Date(Date.now() - 14 * 86400000).toISOString();
  listing.items = [{ ...known, title: "Corrected known article", date: oldDate },
    { ...known, url: `${known.url}-unseen`, title: "Unseen old article", date: oldDate }];
  listing.version += 1;
  const repaired = await collectSource(id);
  assert.deepEqual([repaired.status, repaired.created, repaired.revised], ["ok", 0, 1]);
  const [saved] = await sql`SELECT title,published_at,backfill,backfill_reason FROM articles WHERE source_id=${id}`;
  assert.equal(saved!.title, "Corrected known article");
  assert.equal(new Date(saved!.published_at).toISOString().slice(0, 19), oldDate.slice(0, 19));
  assert.equal(saved!.backfill, true);
  assert.equal(saved!.backfill_reason, "stale-on-discovery");
  assert.equal(await count(id), 1);
});

test("in the tail an alias of a known URL keeps the first record, and URL, category and noise filters still apply", async () => {
  const rows = items("filters", 60);
  rows.push({ ...rows[0]!, url: rows[0]!.url + "?utm_source=tail", title: "不应覆盖首次标题" });
  rows.push(...items("filters-tail", 5));
  rows[62]!.title = "noise 排除条目";
  rows[63]!.url = `${tailBase}/denied/${T}`;
  rows[64]!.category = "drop";
  rows[65]!.url = `${tailBase}/outside/${T}`;
  const { id } = await tailSource("filters", "rss", rows, {
    allowUrlPrefixes: [`${tailBase}/article/`, `${tailBase}/denied/`], denyUrlPrefixes: [`${tailBase}/denied/`],
    allowCategories: ["keep"], denyCategories: ["drop"], ingestNoiseFilter: { dropMarkersTitleOnly: ["noise"] },
  });
  const first = await collectSource(id);
  assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", 66, 61, 0]);
  const [saved] = await sql`SELECT title,revision FROM articles WHERE url=${rows[0]!.url}`;
  assert.deepEqual([saved!.title, saved!.revision], [rows[0]!.title, 1]);
  assert.deepEqual(await collectSource(id, { force: true }), { sourceId: id, status: "ok", found: 66, created: 0, revised: 0 });
  assert.equal(await count(id), 61);
  assert.equal(await revisions(id), 61);
});

test("a storage failure in the tail does not advance the feed's validator; the retry fills in without new revisions", async () => {
  const rows = items("retry", 61);
  const { id, listing } = await tailSource("retry", "rss", rows.slice(0, 1));
  assert.equal((await collectSource(id)).created, 1);
  const previous = await cursor(id);
  listing.items = rows;
  listing.version = 2;
  const constraint = `tail_failure_${T}`;
  // Refuse only this test's tail title: the entries before it commit, and the code needs no fault switch.
  // DDL takes no bound values, so the escaped title goes in as a literal.
  const blockedTitle = sql.unsafe("'" + rows[60]!.title.replaceAll("'", "''") + "'");
  await sql`ALTER TABLE articles ADD CONSTRAINT ${sql(constraint)} CHECK (title <> ${blockedTitle}) NOT VALID`;
  try {
    const failed = await collectSource(id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, new RegExp(constraint));
    assert.equal(await count(id), 60, "the entries before the 61st stay committed");
    assert.deepEqual(await cursor(id), previous);
    const [run] = await sql`SELECT status,found_count FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
    assert.deepEqual([run!.status, run!.found_count], ["failed", 61]);
  } finally {
    await sql`ALTER TABLE articles DROP CONSTRAINT ${sql(constraint)}`;
  }
  const retried = await collectSource(id);
  assert.deepEqual([retried.status, retried.created, retried.revised], ["ok", 1, 0]);
  assert.equal(listing.requests.at(-1)!.etag, '"v1"');
  assert.equal((await cursor(id)).rss.etag, '"v2"');
  assert.equal(await count(id), 61);
  assert.equal(await revisions(id), 61);
  assert.equal(await jobs(id), 61);
  assert.equal((await collectSource(id)).found, 0);
  assert.equal(listing.requests.at(-1)!.status, 304);
});
