// Machines receive one selected seat per fact: several selected reports of one fact give v1, RSS and the
// sync ledger only the representative, a better report taking over removes the old one; a broken
// snapshot page asks for a new snapshot, and a database outage during sync is a retryable answer, never
// a reason to discard the client's snapshot.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { encodeCursor, decodeCursor, queryBinding } from "@aihot/backend/lib/cursor";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const MEDIA = `test-seats-media-${T}`;
const OFFICIAL = `test-seats-official-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
async function report(source: string, fact: number) {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.com/seats-${T}-${n}`, title: `Seat ${n} ${T}`, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`摘要${n}-${T}`}, ${`理由${n}`}, 80, true, ${[`t-${T}`]})`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact}, ${articleId}, 'report')`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  const json = /json/.test(String(res.headers["content-type"] ?? "")) ? JSON.parse(res.body) : null;
  return { status: res.statusCode, json, body: res.body };
};

test("one fact holds one selected seat on v1, RSS and the sync ledger", async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`S-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`seat-${T}`}, ${story!.id}, 'Acquisition') RETURNING id`;
  const snapshot = (await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).json as { cursor: string };

  const first = await report(MEDIA, fact!.id);
  const second = await report(MEDIA, fact!.id);
  const official = await report(OFFICIAL, fact!.id);

  // This test's reports only.
  const items = (await get(`/api/v1/items?mode=selected&window=24h&limit=100&q=${T}`)).json.items as Array<{ id: string }>;
  const ours = items.map((i) => i.id).filter((id) => [first, second, official].includes(id));
  assert.deepEqual(ours, [official], "only the first-party representative");
  const all = (await get(`/api/v1/items?mode=all&window=24h&limit=100&q=${T}`)).json.items as Array<{ id: string; selected: boolean }>;
  assert.deepEqual(all.filter((i) => [first, second].includes(i.id)).map((i) => i.selected), [false, false], "the others are public but not in the seat");

  const rss = (await get("/feed.xml")).body;
  assert.ok(rss.includes(official) && !rss.includes(first) && !rss.includes(second));

  const snap = (await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body;
  assert.ok(snap.includes(official) && !snap.includes(first) && !snap.includes(second));

  // Changes since before: the media report was added, then left when the official one arrived.
  const changes = (await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}&limit=100`)).json.changes as Array<{ op: string; id?: string; item?: { id: string } }>;
  const net = new Map<string, string>();
  for (const c of changes) net.set(c.id ?? c.item!.id, c.op);
  assert.equal(net.get(official), "upsert");
  assert.equal(net.get(first), "remove");
  assert.ok(!net.has(second) || net.get(second) === "remove");
  // 全部动态 and the item page list every report; the ones that yield the seat say which report stands
  // for the fact, and the recommendation reason goes with the seat.
  const pool = (await get(`/api/site/pool?q=${T}`)).json.items as Array<{ id: string; reason: string | null; sameEvent?: { id: string } | null }>;
  assert.equal(pool.find((i) => i.id === first)?.sameEvent?.id, official);
  assert.equal(pool.find((i) => i.id === first)?.reason, null);
  assert.equal(pool.find((i) => i.id === official)?.sameEvent ?? null, null);
  const detail = (await get(`/api/site/items/${first}`)).json as { reason: string | null; sameEvent?: { id: string } | null };
  assert.equal(detail.sameEvent?.id, official);
  assert.equal(detail.reason, null);
  assert.ok(!(await get(`/items/${first}/markdown`)).body.includes("推荐理由"));
  assert.ok((await get(`/items/${official}/markdown`)).body.includes("推荐理由"));
  // The website still folds every report of the fact into the reading group.
  const home = (await get(`/api/site/timeline?limit=40&tag=${encodeURIComponent(`t-${T}`)}`)).json.cards as Array<{ item: { id: string }; group: { reportCount: number } | null }>;
  const card = home.find((c) => c.item.id === official);
  assert.equal(card?.group?.reportCount, 3);

  // A later evaluation of the same product is another news item in every selected outlet.
  // It must not replace the launch, inherit its copy, or lift its original timeline position.
  const timelineQuery = { channel: "all" as const, category: null, tag: `t-${T}`, now: new Date() };
  const before = await loadTimeline(timelineQuery);
  const [evaluation] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`evaluation-${T}`}, ${story!.id}, 'New evaluation') RETURNING id`;
  const evaluated = await report(MEDIA, evaluation!.id);
  const after = await loadTimeline({ ...timelineQuery, now: new Date() });
  assert.deepEqual(after.cards.map(c => c.item.id), [evaluated, official]);
  assert.equal(after.cards.find(c => c.item.id === official)!.anchorAt, before.cards[0]!.anchorAt);
  assert.equal(after.cards[0]!.item.source.name, 'Media');
  assert.equal(after.cards[0]!.group, null, 'one report needs no duplicate-report expansion');
  const selected = (await get(`/api/v1/items?mode=selected&window=24h&limit=100&q=${T}`)).json.items as Array<{ id: string }>;
  assert.deepEqual(selected.map(i => i.id), [evaluated, official]);
  const feed = (await get('/feed.xml')).body;
  assert.ok(feed.includes(evaluated) && feed.includes(official) && !feed.includes(first));
  const agent = (await get('/api/v1/agent/latest?limit=30')).body;
  assert.ok(agent.includes(evaluated) && agent.includes(official) && !agent.includes(first));

});

test("a broken or empty snapshot page asks for a new snapshot", async () => {
  for (const page of ["", "not-a-page", "ax1.eyJrIjoicGFnZSJ9"]) {
    const res = await get(`/api/v1/selected/snapshot?page=${encodeURIComponent(page)}`);
    assert.equal(res.status, 409, `page=${page}`);
    assert.equal(res.json.code, "snapshot_required");
  }
});

// Failure cases: JSON-decodable but incomplete/invalid cursors (including a watermark beyond the
// ledger) and a temporary database outage. Neither may become usable sync state or tell clients to
// discard good state.
test('malformed cursor fields are client errors, never database errors or usable sync state', async () => {
  const snapshot = (await get('/api/v1/selected/snapshot?limit=1')).json;
  const sync = decodeCursor('ax1', snapshot.cursor);
  const page = { ...sync, k: 'page', a: 'anchor', t: new Date().toISOString() };
  for (const patch of [{ w: -1 }, { w: 0.5 }, { w: 1e100 }, { a: null }, { a: 3 }, { t: null }, { t: 'invalid' }, { w: Number(sync.w) + 1 }]) {
    const res = await get(`/api/v1/selected/snapshot?page=${encodeCursor('ax1', { ...page, ...patch })}`);
    assert.deepEqual([res.status, res.json.code], [409, 'snapshot_required'], JSON.stringify(patch));
  }
  for (const w of [-1, 0.5, 1e100]) {
    const res = await get(`/api/v1/selected/changes?cursor=${encodeCursor('ax1', { ...sync, w })}`);
    assert.deepEqual([res.status, res.json.code], [409, 'snapshot_required'], String(w));
  }
  const c = queryBinding({ m: 'all', w: '7d', b: 'timeline', c: null, q: null });
  const res = await get(`/api/v1/items?mode=all&cursor=${encodeCursor('it3', { a: 1e100, i: 'anchor', c })}`);
  assert.deepEqual([res.status, res.json.code], [400, 'invalid_cursor']);
});

test('a sync database failure is retryable without replacing the client snapshot', async () => {
  const cursor = (await get('/api/v1/selected/snapshot')).json.cursor;
  await sql`ALTER TABLE selected_ledger RENAME TO selected_ledger_unavailable`;
  try {
    const res = await app.inject({ method: 'GET', url: `/api/v1/selected/changes?cursor=${encodeURIComponent(cursor)}` });
    assert.deepEqual([res.statusCode, res.json().code], [503, 'temporarily_unavailable']);
    assert.equal(res.headers['retry-after'], '30');
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    await sql`ALTER TABLE selected_ledger_unavailable RENAME TO selected_ledger`;
  }
});
