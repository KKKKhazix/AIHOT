// Public scope and sync through the real api routes: a licence revocation or a withdrawal reaches
// every exit, reports stop quoting withdrawn items, the hot board drops a withdrawn item at once, item
// pages follow the site's rule, an early release keeps the selected ledger in order, a withdrawal
// waiting behind an unreleased item leaves new snapshots at once, and snapshots answer conditional requests.
import { config } from "@aihot/backend/config";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate, isoWeekLabel } from "@aihot/contracts/time";
import { ogEtag } from "../apps/api/src/og/render.ts";
import { posterEtag } from "../apps/api/src/og/poster.ts";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { setVisibility } from "@aihot/backend/admin/content";
import { updateSource } from "@aihot/backend/admin/sources";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, republishSource } from "@aihot/backend/publication/publish";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { latestHotRanking } from "@aihot/backend/publication/hot";
import { effectiveWatermark } from "@aihot/backend/publication/v1";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-publication-${T}`;
const BODY = `FULLTEXT-${T} `.repeat(40);
const REPORT_KEY = `2099-12-${String(10 + Math.floor(Math.random() * 19))}`;
const WEEKLY_KEY = isoWeekLabel(REPORT_KEY);
const MONTHLY_KEY = REPORT_KEY.slice(0, 7);
const app = await buildApp();

before(async () => {
  // An interrupted earlier run may have left entries behind the release gate, holding the watermark.
  await sql`UPDATE selected_ledger SET visible_at = now() WHERE visible_at > now()`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test publication', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM reports WHERE (kind = 'daily' AND key = ${REPORT_KEY}) OR (kind = 'weekly' AND key = ${WEEKLY_KEY}) OR (kind = 'monthly' AND key = ${MONTHLY_KEY})`;
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A selected article with full text and a summary. */
async function article(): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-${n}`, title: `Test ${n}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${`标题${n}-${T}`}, ${`SUMMARY-${n}-${T}`}, '理由', 90, true)`;
  return articleId;
}

async function storyFor(id: string, role: "report" | "mention" = "report"): Promise<string> {
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`STORY-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${publicId}`}, ${story!.id}, ${`FACT-${T}`}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, ${role})`;
  return publicId;
}

const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: res.body, etag: res.headers.etag as string | undefined };
}

test("site reading sends one language while exports retain both, including after withdrawal", async () => {
  const id = await article();
  await sql`UPDATE articles SET language = 'en', body_html = '<h2>Original heading</h2><p>Original full body</p>' WHERE id = ${id}`;
  await sql`INSERT INTO translations (article_id, revision, body_html, body_text, origin) VALUES (${id}, 1, '<h2>译文标题</h2><p>中文完整正文</p>', '中文完整正文', 'source')`;
  await publishArticle(id, released());
  const normal = JSON.parse((await get(`/api/site/items/${id}`)).body);
  const original = JSON.parse((await get(`/api/site/items/${id}/original`)).body);
  assert.equal(normal.bodyLanguage, 'zh');
  assert.equal(normal.hasTranslation, true);
  assert.equal(normal.body.original, null);
  assert.ok(normal.body.zh.includes('中文完整正文'));
  assert.equal(normal.outline[0].text, '译文标题');
  assert.equal(original.bodyLanguage, 'original');
  assert.equal(original.body.zh, null);
  assert.ok(original.body.original.includes('Original full body'));
  assert.equal(original.outline[0].text, 'Original heading');
  const md = (await get(`/items/${id}/markdown`)).body;
  assert.ok(md.includes('Original full body') && md.includes('中文完整正文'));
  await setVisibility(id, { visibility: 'withdrawn', reason: 'test', version: 0 }, 'test');
  assert.equal((await get(`/api/site/items/${id}/original`)).status, 404);
});

test("revoking a source's licence takes its articles off every exit", async () => {
  const id = await article();
  await publishArticle(id, released());
  const story = await storyFor(id);
  assert.equal((await get(`/api/site/items/${id}`)).status, 200);
  assert.equal((await get(`/api/site/stories/${story}`)).status, 200);
  assert.ok((await get("/feed/full.xml")).body.includes(`FULLTEXT-${T}`), "full feed carries the body before");
  assert.ok((await get("/api/v1/items?mode=selected")).body.includes(id), "v1 lists the item before");

  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${SOURCE}`;
  const patch = { participation_mode: "isolated", site_fulltext: false, syndicate_fulltext: false };
  await updateSource(SOURCE, { patch, version: source!.updated_at.toISOString(), reason: "test" }, "test");
  const [queued] = await sql<{ value: { status: string } }[]>`SELECT value FROM settings WHERE key = ${`republish.source:${SOURCE}`}`;
  assert.equal(queued?.value.status, "queued", "the admin change queues a background republish");

  const result = await republishSource(SOURCE); // what the queued job runs
  assert.ok(result.reduced >= 1);
  assert.equal((await get(`/api/site/items/${id}`)).status, 404);
  assert.equal((await get(`/items/${id}/markdown`)).status, 404);
  assert.equal((await get(`/api/site/stories/${story}`)).status, 404, "the story drops an isolated source's last report");
  assert.equal((await get(`/api/v1/stories/${story}`)).status, 404);
  assert.ok(!(await get("/feed/full.xml")).body.includes(`FULLTEXT-${T}`), "full feed drops the body");
  assert.ok(!(await get("/api/v1/items?mode=selected")).body.includes(id), "v1 drops the item");

  await sql`UPDATE sources SET participation_mode = 'editorial', site_fulltext = true, syndicate_fulltext = true WHERE id = ${SOURCE}`;
});

test("a withdrawn item leaves every report exit", async () => {
  const id = await article();
  await publishArticle(id, released());
  const content = {
    sections: [{ label: "模型", items: [{ itemId: id, title: `LEAD-${T}`, summary: `QUOTED-${T}`, sourceUrl: `https://example.com/original-${T}`, sourceName: "Test" }] }],
    flashes: [],
  };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('daily', ${REPORT_KEY}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'manual')
            ON CONFLICT (kind, key) DO UPDATE SET content = EXCLUDED.content`;
  assert.ok((await get(`/api/v1/dailies/${REPORT_KEY}`)).body.includes(`QUOTED-${T}`), "the report quotes the item before");

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const url of [`/api/v1/dailies/${REPORT_KEY}`, `/api/site/reports/daily/${REPORT_KEY}`]) {
    const res = await get(url);
    assert.equal(res.status, 200, url);
    assert.ok(!res.body.includes(`QUOTED-${T}`) && !res.body.includes(`original-${T}`), `${url} still quotes the withdrawn item`);
  }
  for (const url of ["/api/v1/dailies"]) {
    const res = await get(url);
    assert.ok(res.body.includes(REPORT_KEY), `${url} lists the report`);
    assert.ok(!res.body.includes(`LEAD-${T}`), `${url} headlines the withdrawn title`);
  }
});

test("weekly v1 exposes published issues with stable lookup, caching and withdrawal filtering", async () => {
  const id = await article();
  await publishArticle(id, released());
  const content = {
    overview: `OVERVIEW-${T}`,
    themes: [{
      heading: "模型",
      summary: `THEME-${T}`,
      storyRefs: [{
        itemId: id,
        title: `WEEKLY-LEAD-${T}`,
        summary: `WEEKLY-QUOTED-${T}`,
        sourceUrl: `https://example.com/weekly-original-${T}`,
        sourceName: "Test",
        publishedAt: new Date().toISOString(),
      }],
    }],
    storyOrder: [id],
  };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('weekly', ${WEEKLY_KEY}, now() - interval '7 days', now(), ${sql.json(content as never)}, now(), 'manual')
            ON CONFLICT (kind, key) DO UPDATE SET content = EXCLUDED.content, generated_at = EXCLUDED.generated_at`;

  const list = await get("/api/v1/weeklies?limit=1");
  assert.equal(list.status, 200);
  assert.ok(list.body.includes(WEEKLY_KEY) && list.body.includes(`WEEKLY-LEAD-${T}`));

  const detail = await get(`/api/v1/weeklies/${WEEKLY_KEY}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.includes(`WEEKLY-QUOTED-${T}`) && detail.body.includes(`weekly-original-${T}`));
  assert.ok(detail.etag);
  assert.equal((await get(`/api/v1/weeklies/${WEEKLY_KEY}`, { "if-none-match": detail.etag! })).status, 304);

  const latest = await get("/api/v1/weeklies/latest");
  assert.equal(latest.status, 200);
  assert.ok(latest.body.includes(WEEKLY_KEY));

  assert.equal((await get("/api/v1/weeklies/2099-W00")).status, 400);
  assert.equal((await get("/api/v1/weeklies/2098-W01")).status, 404);

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  const withdrawn = await get(`/api/v1/weeklies/${WEEKLY_KEY}`);
  assert.equal(withdrawn.status, 200);
  assert.ok(!withdrawn.body.includes(`WEEKLY-QUOTED-${T}`) && !withdrawn.body.includes(`WEEKLY-LEAD-${T}`) && !withdrawn.body.includes(`weekly-original-${T}`));
});

test("monthly v1 exposes published issues with stable lookup, caching and withdrawal filtering", async () => {
  const id = await article();
  await publishArticle(id, released());
  const content = {
    overview: `OVERVIEW-${T}`,
    themes: [{
      heading: "模型",
      summary: `THEME-${T}`,
      storyRefs: [{
        itemId: id,
        title: `MONTHLY-LEAD-${T}`,
        summary: `MONTHLY-QUOTED-${T}`,
        sourceUrl: `https://example.com/monthly-original-${T}`,
        sourceName: "Test",
        publishedAt: new Date().toISOString(),
      }],
    }],
    storyOrder: [id],
  };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('monthly', ${MONTHLY_KEY}, now() - interval '7 days', now(), ${sql.json(content as never)}, now(), 'manual')
            ON CONFLICT (kind, key) DO UPDATE SET content = EXCLUDED.content, generated_at = EXCLUDED.generated_at`;

  const list = await get("/api/v1/monthlies?limit=1");
  assert.equal(list.status, 200);
  assert.ok(list.body.includes(MONTHLY_KEY) && list.body.includes(`MONTHLY-LEAD-${T}`));

  const detail = await get(`/api/v1/monthlies/${MONTHLY_KEY}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.includes(`MONTHLY-QUOTED-${T}`) && detail.body.includes(`monthly-original-${T}`));
  assert.ok(detail.etag);
  assert.equal((await get(`/api/v1/monthlies/${MONTHLY_KEY}`, { "if-none-match": detail.etag! })).status, 304);

  const latest = await get("/api/v1/monthlies/latest");
  assert.equal(latest.status, 200);
  assert.ok(latest.body.includes(MONTHLY_KEY));

  assert.equal((await get("/api/v1/monthlies/2099-13")).status, 400);
  assert.equal((await get("/api/v1/monthlies/2098-01")).status, 404);

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  const withdrawn = await get(`/api/v1/monthlies/${MONTHLY_KEY}`);
  assert.equal(withdrawn.status, 200);
  assert.ok(!withdrawn.body.includes(`MONTHLY-QUOTED-${T}`) && !withdrawn.body.includes(`MONTHLY-LEAD-${T}`) && !withdrawn.body.includes(`monthly-original-${T}`));
});

test("a withdrawal takes down only the stories citing it, including secondary memberships", async () => {
  const id = await article();
  await publishArticle(id, released());
  const stories = [await storyFor(id), await storyFor(id, "mention")];
  const other = await article();
  await publishArticle(other, released());
  const unrelated = await storyFor(other);
  for (const story of stories) {
    assert.ok((await get(`/api/site/stories/${story}`)).body.includes(id));
    assert.ok((await get(`/api/v1/stories/${story}`)).body.includes(id));
  }

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const story of stories) {
    assert.equal((await get(`/api/site/stories/${story}`)).status, 404);
    assert.equal((await get(`/api/v1/stories/${story}`)).status, 404);
  }
  assert.equal((await get(`/api/site/stories/${unrelated}`)).status, 200);
});

test("a withdrawn item leaves the hot board and the hot APIs at once, not at the next ranking", async () => {
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`HOT-${T}`}, now() - interval '2 hours', now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${T}`}, ${story!.id}, ${`HOT-${T}`}) RETURNING id`;
  const secondSource = `${SOURCE}-hot-b`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${secondSource}, 'Test independent source', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  for (const [index, id] of [await article(), await article()].entries()) {
    const sourceId = index === 0 ? SOURCE : secondSource;
    await sql`UPDATE articles SET source_id = ${sourceId} WHERE id = ${id}`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
              VALUES (${story!.id}, ${id}, ${`participant-${id}`}, ${sourceId}, 'editorial', now() - interval '1 hour')`;
    await publishArticle(id, released());
  }
  await computeHotRanking();
  const rep = (await latestHotRanking())!.entries.find((e) => e.storyId === story!.id)?.representativeItemId;
  assert.ok(rep, "the story is on the board with a representative item");
  const exits = ["/api/v1/hot-topics", "/api/site/hot"];
  for (const url of exits) assert.ok((await get(url)).body.includes(rep!), `${url} shows the item before`);

  await setVisibility(rep!, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const url of exits) assert.ok(!(await get(url)).body.includes(rep!), `${url} still shows the withdrawn item`);
});

test("item pages follow the live rule: unsummarised editorial items keep one, hot_signal items have none", async () => {
  const SIGNAL = `${SOURCE}-signal`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SIGNAL}, 'Test signal', 'rss', 'T1', 'hot_signal', true, false, '2100-01-01')`;
  const material = (sourceId: string, name: string) =>
    upsertMaterial({ sourceId, url: `https://example.com/${T}-${name}`, title: `${name} ${T}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  // An editorial item the model never summarised, and a hot_signal item carrying an imported summary.
  const { articleId: plain } = await material(SOURCE, "plain");
  await publishArticle(plain);
  const { articleId: signal } = await material(SIGNAL, "signal");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${signal}, 1, 'replay', 'pass', 'industry', ${`信号-${T}`}, ${`SIGNAL-SUMMARY-${T}`}, 80, false)`;
  await publishArticle(signal);

  const page = await get(`/api/site/items/${plain}`);
  assert.equal(page.status, 200, "an unsummarised editorial item keeps its page");
  const detail = JSON.parse(page.body) as { summary: string | null; indexable: boolean; markdownAvailable: boolean };
  assert.deepEqual([detail.summary, detail.indexable, detail.markdownAvailable], [null, false, true], "noindex, with its body for export");
  assert.equal((await get(`/items/${plain}/markdown`)).status, 200);
  assert.equal((await get(`/api/site/items/${signal}`)).status, 404, "hot_signal material has no page");
  assert.equal((await get(`/items/${signal}/markdown`)).status, 404);

  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`事件-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}`}, ${story!.id}, ${`事实-${T}`}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${plain}, 'report'), (${fact!.id}, ${signal}, 'report')`;
  const storyPage = await get(`/api/site/stories/${publicId}`);
  assert.equal(storyPage.status, 200, "a story whose only page is unsummarised still has a page");
  assert.ok(storyPage.body.includes(plain), "it lists the unsummarised editorial report");
  assert.ok(!storyPage.body.includes(signal) && !storyPage.body.includes(`SIGNAL-SUMMARY-${T}`), "and not the hot_signal one");
});

test("an early release keeps the selected ledger in order", async () => {
  const x = await article();
  await publishArticle(x, released());
  const y = await article();
  await publishArticle(y); // still behind the release gate
  await setVisibility(x, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  await sql`UPDATE articles SET grouped_at = now() WHERE id = ${y}`;
  await publishArticle(y); // grouped: released now

  const [entry] = await sql<{ seq: number }[]>`SELECT max(seq)::int AS seq FROM selected_ledger WHERE article_id = ${y}`;
  assert.ok((await effectiveWatermark()) >= entry!.seq, "the sync watermark covers the released item");
  const snapshot = await get("/api/v1/selected/snapshot?fields=minimal&limit=1000");
  assert.ok(snapshot.body.includes(y), "released item is in the snapshot");
  assert.ok(!snapshot.body.includes(x), "withdrawn item is not");
});

test("a withdrawal waiting behind an unreleased item leaves new snapshots at once, and changes still carry both", async () => {
  const x = await article();
  await publishArticle(x, released());
  const y = await article();
  await publishArticle(y); // behind the release gate: the watermark stays before it
  await setVisibility(x, { visibility: "withdrawn", reason: "test", version: 0 }, "test");

  for (const url of ["/api/v1/selected/snapshot?fields=minimal&limit=1000"]) {
    const body = (await get(url)).body;
    assert.ok(!body.includes(x), `${url} still lists the withdrawn item`);
    assert.ok(!body.includes(y), `${url} lists an item before its release`);
  }
  // A client that saved this snapshot's watermark receives y and x's removal once y is released.
  const snapshot = JSON.parse((await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body) as { cursor: string };
  await sql`UPDATE articles SET grouped_at = now() WHERE id = ${y}`;
  await publishArticle(y);
  const changes = JSON.parse((await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}&limit=100`)).body) as {
    changes: Array<{ op: string; id?: string; item?: { id: string } }>;
  };
  const ours = changes.changes.map((c) => `${c.op}:${c.id ?? c.item?.id}`).filter((c) => c.endsWith(x) || c.endsWith(y));
  assert.deepEqual(ours, [`upsert:${y}`, `remove:${x}`]);
});

test("snapshots answer 304 to their own ETag", async () => {
  for (const url of ["/api/v1/selected/snapshot?fields=minimal&limit=1000"]) {
    const first = await get(url);
    assert.ok(first.etag, `${url} has an ETag`);
    assert.equal((await get(url, { "if-none-match": first.etag! })).status, 304, url);
  }
});

test("v1 story retains website content and fallback ordering without the website-only heat reads", async () => {
  const first = await article();
  const second = await article();
  await publishArticle(first, released());
  await publishArticle(second, released());
  const publicId = await storyFor(first);
  const [story] = await sql<{ id: number }[]>`SELECT id FROM stories WHERE public_id = ${publicId}`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`v1-development-${T}`}, ${story!.id}, 'Latest development fallback') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${second}, 'report')`;
  await sql`UPDATE publications SET published_at = now() - interval '1 hour' WHERE article_id = ${first}`;
  await sql`UPDATE stories SET first_report_at = NULL, latest_at = NULL WHERE id = ${story!.id}`;
  const site = JSON.parse((await get(`/api/site/stories/${publicId}`)).body);
  const v1 = JSON.parse((await get(`/api/v1/stories/${publicId}`)).body).story;
  assert.deepEqual({ publicId: v1.publicId, title: v1.title, sourceCount: v1.sourceCount, reportCount: v1.reportCount,
    firstReportAt: v1.firstReportAt, latestAt: v1.latestAt, digest: v1.digest, digestUpdatedAt: v1.digestUpdatedAt },
  { publicId: site.publicId, title: site.title, sourceCount: site.sourceCount, reportCount: site.reportCount,
    firstReportAt: site.firstReportAt, latestAt: site.latestAt, digest: site.digest, digestUpdatedAt: site.digestUpdatedAt });
  assert.equal(v1.latest, 'Latest development fallback');
  assert.deepEqual(v1.reports, site.timeline.slice(0, 50).map((r: any) => ({ id: r.id, title: r.title, summary: r.summary,
    source: { name: r.source.name, firstParty: r.source.firstParty }, publishedAt: r.publishedAt,
    links: { aihot: `${config.siteUrl}/items/${r.id}`, original: r.originalUrl } })));
  await sql`UPDATE publications SET visible_after = now() + interval '1 day' WHERE article_id = ${second}`;
  const gated = JSON.parse((await get(`/api/v1/stories/${publicId}`)).body).story;
  assert.deepEqual(gated.reports.map((r: any) => r.id), [first]);
  assert.equal(gated.latest, `FACT-${T}`);
});


test("unchanged republishing preserves freshness, while URL-only changes still reach the projection and ledger", async () => {
  const id = await article();
  await publishArticle(id, released());
  const state = async () => (await sql`SELECT xmin::text AS row_version, updated_at, revision, url FROM publications WHERE article_id = ${id}`)[0]!;
  const before = await state();
  const [ledger] = await sql`SELECT max(seq) AS seq FROM selected_ledger WHERE article_id = ${id}`;
  const unchanged = await publishArticle(id);
  assert.equal(unchanged!.changed, false);
  assert.equal(unchanged!.ledger, null);
  assert.deepEqual({ ...await state() }, { ...before }, "no new tuple or freshness timestamp for identical content");
  assert.equal((await sql`SELECT max(seq) AS seq FROM selected_ledger WHERE article_id = ${id}`)[0]!.seq, ledger!.seq);

  const url = `https://example.com/${T}-corrected`;
  await sql`UPDATE articles SET url = ${url} WHERE id = ${id}`;
  const result = await publishArticle(id);
  assert.equal(result!.changed, false, "URL is deliberately outside the presentation fingerprint");
  assert.equal(result!.ledger, "upsert", "the public URL change is still recorded for sync clients");
  const changed = await state();
  assert.equal(changed.url, url);
  assert.notEqual(changed.row_version, before.row_version);
  assert.ok(changed.updated_at >= before.updated_at);
  assert.equal(changed.revision, before.revision);
});

test("share images keep detail metadata and access rules while conditional reads avoid body hydration", async () => {
  const id = await article();
  await publishArticle(id, released());
  const d = JSON.parse((await get(`/api/site/items/${id}`)).body);
  const kicker = d.category ? CATEGORY_LABELS[d.category as keyof typeof CATEGORY_LABELS] : "AI 动态";
  const source = d.source.name.replace(/（[^）]*）\s*$/, "");
  const date = beijingDate(d.timelineAt);
  const card = { kicker, title: d.title, subtitle: d.summary, meta: `${source} · ${date}`,
    badge: d.selected && d.score !== null ? { value: String(Math.round(d.score)), label: "精选评分" } : null };
  const poster = { url: `${config.siteUrl}/items/${id}`, kicker, title: d.title, summary: d.summary, source, date, score: d.selected ? d.score : null };
  const paths = [[`/og/items/${id}.png`, `"og-${ogEtag(card)}"`], [`/og/posters/${id}.png`, `"poster-${posterEtag(poster)}"`]];
  const queries: string[] = [];
  const previous = sql.options.debug;
  sql.options.debug = (_connection, query) => { queries.push(query); };
  try {
    for (const [path, etag] of paths) {
      const response = await get(path!, { "if-none-match": etag! });
      assert.equal(response.status, 304);
      assert.equal(response.etag, etag);
    }
    assert.equal(queries.length, 2);
    assert.ok(queries.every((q) => !/body_html|body_text|translations|fact_articles/.test(q)), "cards only load their public metadata");
  } finally { sql.options.debug = previous; }
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${id}`;
  assert.equal((await get(paths[0]![0]!, { "if-none-match": paths[0]![1]! })).status, 304, "summary-only pages keep the same allowed share summary");
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  for (const [path, etag] of paths) assert.equal((await get(path!, { "if-none-match": etag! })).status, 404, "cached ETags never bypass current visibility");
});

test("minimal sync projection preserves snapshot fields, pagination bindings and ordered changes", async () => {
  const id = await article();
  await publishArticle(id, released());
  await publishArticle(await article(), released());
  const full = JSON.parse((await get('/api/v1/selected/snapshot?fields=default&limit=1000')).body);
  const minimal = JSON.parse((await get('/api/v1/selected/snapshot?fields=minimal&limit=1000')).body);
  const project = (i: any) => ({ id: i.id, title: i.title, source: i.source, publishedAt: i.publishedAt,
    discoveredAt: i.discoveredAt, category: i.category, score: i.score, selected: i.selected, links: { aihot: i.links.aihot } });
  assert.deepEqual(minimal.items, full.items.map(project));
  assert.ok(minimal.items.some((i: any) => i.id === id));
  for (const fields of ['default', 'minimal']) {
    const first = JSON.parse((await get(`/api/v1/selected/snapshot?limit=1${fields === 'minimal' ? '&fields=minimal' : ''}`)).body);
    assert.ok(first.nextPage);
    const response = await get(`/api/v1/selected/snapshot?limit=1000&page=${encodeURIComponent(first.nextPage)}`);
    assert.equal(response.status, 200, 'continuations inherit the projection from the page token');
    const next = JSON.parse(response.body);
    assert.equal(next.fields, fields);
    assert.equal(next.cursor, first.cursor);
    assert.equal(next.asOf, first.asOf);
    assert.equal(next.hasMore, false);
    assert.deepEqual([...first.items, ...next.items], fields === 'minimal' ? minimal.items : full.items);
  }
  const firstPage = JSON.parse((await get('/api/v1/selected/snapshot?fields=minimal&limit=1')).body);
  assert.ok(firstPage.nextPage);
  assert.equal((await get(`/api/v1/selected/snapshot?fields=default&page=${encodeURIComponent(firstPage.nextPage)}`)).status, 400, 'page tokens stay bound to the requested projection');
  await sql`UPDATE analyses SET title_zh = 'Updated sync title', summary_zh = ${'large summary '.repeat(200)} WHERE article_id = ${id}`;
  await publishArticle(id, released());
  const getChanges = async (cursor: string) => {
    const response = await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(cursor)}&limit=100`);
    assert.equal(response.status, 200, response.body);
    return JSON.parse(response.body);
  };
  const fullChanges = await getChanges(full.cursor);
  const minimalChanges = await getChanges(minimal.cursor);
  assert.deepEqual(minimalChanges.changes, fullChanges.changes.map((c: any) => c.op === 'upsert' ? { ...c, item: project(c.item) } : c));
  assert.equal(minimalChanges.changes.find((c: any) => c.item?.id === id)?.item.title, 'Updated sync title');
  await setVisibility(id, { visibility: 'withdrawn', reason: 'sync test', version: 0 }, 'test');
  const removed = await getChanges(minimalChanges.cursor);
  assert.ok(removed.changes.some((c: any) => c.op === 'remove' && c.id === id));
});

// Failure cases: an offline client resumes before a withdrawal; a one-entry page must not send the
// old content and wait for a later remove; both field projections and legacy clients must advance.
test('historical sync never redistributes withdrawn content, even on a one-entry page', async () => {
  for (const visibility of ['withdrawn', 'summary-only'] as const) {
    for (const fields of ['minimal', 'default']) {
      const start = JSON.parse((await get(`/api/v1/selected/snapshot?fields=${fields}`)).body).cursor;
      const id = await article();
      await publishArticle(id, released());
      await setVisibility(id, { visibility, reason: 'test offline sync', version: 0 }, 'test');
      for (const [prefix, limit] of [['v1', 'limit']]) {
        const response = await get(`/api/${prefix}/selected/changes?${limit}=1&cursor=${encodeURIComponent(start)}`);
        assert.equal(response.status, 200);
        const page = JSON.parse(response.body);
        assert.equal(page.changes[0].op, 'remove', `${prefix} ${fields} ${visibility}`);
        assert.equal(page.changes[0].id, id);
        assert.equal(page.changes[0].item, undefined);
        assert.notEqual(page.cursor, start, 'redacting a historical upsert must still advance');
        assert.equal(page.hasMore, true, 'the later removal is still resumable');
      }
    }
  }
});

test('event neighbors disappear when their last readable evidence is withdrawn or still gated', async () => {
  const id = await article();
  const neighborId = await article();
  await publishArticle(id, released());
  await publishArticle(neighborId, released());
  const current = await storyFor(id);
  const neighbor = await storyFor(neighborId);
  await sql`INSERT INTO story_links (story_id, other_id, relation)
    SELECT s.id, n.id, 'related' FROM stories s, stories n WHERE s.public_id = ${current} AND n.public_id = ${neighbor}`;
  const exits = [`/api/site/stories/${current}`, `/api/v1/stories/${current}`, `/api/v1/agent/stories/${current}`];
  for (const url of exits) assert.ok((await get(url)).body.includes(neighbor), 'public neighbor is linked');
  for (const gated of [true, false]) {
    await sql`UPDATE publications SET visible_after = now() + interval '1 hour', visibility = ${gated ? 'public' : 'withdrawn'} WHERE article_id = ${neighborId}`;
    assert.equal((await get(`/api/v1/stories/${neighbor}`)).status, 404);
    for (const url of exits) assert.ok(!(await get(url)).body.includes(neighbor), `${url} must not advertise an unreadable neighbor`);
  }
});
