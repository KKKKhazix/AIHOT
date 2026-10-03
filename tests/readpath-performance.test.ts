// The optimized reads retain ranking, capped totals, public scope, report fallback and clock-driven
// polling versions. These use a disposable database and real HTTP handlers/SQL, never paid services.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { loadPool } from '@aihot/backend/publication/pool';
import { v1Items } from '@aihot/backend/publication/v1';
import { itemFeed } from '@aihot/backend/publication/feeds';
import { issueLead, listReports, reportIndexRows, unavailableIds } from '@aihot/backend/publication/reports';
import { buildApp } from '../apps/api/src/app.ts';

const T = `readperf${tag()}`;
const SOURCE = `test-${T}`;
const now = new Date();
const id = (n: number) => `${T}-${String(n).padStart(4, '0')}`;
const filters = { channel: 'all' as const, category: null, tag: T, now };
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Performance fixture', 'rss', 'T1', 'editorial', '2100-01-01')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at, body_html, language)
    SELECT ${T} || '-' || lpad(n::text, 4, '0'), ${SOURCE}, ${T} || '-' || n, 'https://example.org/' || ${T} || '/' || n,
      ${T} || CASE WHEN n = 1 THEN ' needle' ELSE ' general' END, ${now}, ${now}, ${now}, '<p>licensed body</p>', 'en'
    FROM generate_series(1, 2108) n`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, published_at, sort_at,
      eligible, selected, visible_after, visibility, search_text, tags, summary, body_mode, syndicate)
    SELECT a.id, a.title, a.source_id, 'news', a.url, a.discovered_at, a.timeline_at, a.published_at, a.timeline_at,
      a.id <> ${id(2108)}, a.id = ${id(2108)}, ${new Date(+now - 1000)},
      CASE WHEN a.id = ${id(2106)} THEN 'withdrawn' ELSE 'public' END,
      ${T} || ' needle', ${[T]}, 'fixture summary', 'full', false FROM articles a WHERE a.source_id = ${SOURCE}`;
  await sql`INSERT INTO pool_search (article_id, direct, body)
    SELECT article_id, search_text, CASE WHEN right(article_id, 4)::int % 2 = 0 THEN 'needle bodyonly' ELSE 'needle' END
    FROM publications WHERE source_id = ${SOURCE} AND eligible`;
});

after(async () => {
  await app.close();
  await sql`DELETE FROM reports WHERE content->>'fixture' = ${T}`;
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await closeDb();
});

test('relevance ranks all candidates, caps the public total at 2000 and keeps empty page totals', async () => {
  const first = await loadPool({ ...filters, q: `${T} needle`, tab: 'relevance' });
  assert.equal(first.total, 2000);
  assert.equal(first.pageCount, 50);
  assert.equal(first.items.length, 40);
  assert.equal(first.items[0]!.id, id(1), 'title match outranks more recent body/direct matches');
  assert.equal(first.items[1]!.id, id(2107), 'ties use timeline then id descending');
  const last = await loadPool({ ...filters, q: `${T} needle`, tab: 'relevance', page: 500 });
  assert.equal(last.page, 50);
  assert.equal(last.items.length, 40);
  assert.equal(last.total, 2000);
  const sparse = await loadPool({ ...filters, q: `${T} general`, tab: 'relevance', page: 2 });
  assert.deepEqual([sparse.total, sparse.items.length], [0, 0]);
  const beyond = await loadPool({ ...filters, q: `${T} bodyonly`, tab: 'relevance', page: 50 });
  assert.deepEqual([beyond.total, beyond.items.length, beyond.pageCount], [1052, 0, 27], 'an empty deep page still has the capped total');
  const empty = await loadPool({ ...filters, q: 'absent-needle-xyz', tab: 'relevance', page: 50 });
  assert.deepEqual([empty.total, empty.items.length, empty.pageCount], [0, 0, 1]);
});

test('site cards omit unread payload while the detail retains its original body', async () => {
  const result = await loadPool({ ...filters, q: `${T} needle`, tab: 'relevance' });
  const card = result.items.find((item) => item.id === id(1))!;
  assert.equal(card.title, `${T} needle`);
  assert.equal(card.summary, 'fixture summary');
  assert.deepEqual(card.source, { name: 'Performance fixture' });
  for (const field of ['links', 'originalTitle', 'revision', 'discoveredAt', 'story']) {
    assert.ok(!(field in card), `site card does not serialize ${field}`);
  }
  const detail = (await app.inject({ method: 'GET', url: `/api/site/items/${id(1)}` })).json();
  assert.equal(detail.links.original, `https://example.org/${T}/1`);
  assert.ok(detail.body.original?.includes('licensed body'), 'the detail retains licensed original text');
});

test('unfiltered single-term relevance combines direct/body scores and retains one-sided and empty matches', async () => {
  const shared = `fieldboth${tag()}`;
  const direct = `fielddirect${tag()}`;
  const body = `fieldbody${tag()}`;
  await sql`UPDATE pool_search SET direct = direct || ' ' || ${shared} WHERE article_id IN (${id(1)}, ${id(2)})`;
  await sql`UPDATE pool_search SET body = body || ' ' || ${shared} WHERE article_id IN (${id(2)}, ${id(3)})`;
  await sql`UPDATE pool_search SET direct = direct || ' ' || ${direct}, body = body || ' ' || ${body} WHERE article_id = ${id(4)}`;
  // Include a withdrawn match.
  await sql`UPDATE pool_search SET direct = direct || ' ' || ${shared} WHERE article_id = ${id(2106)}`;
  const query = { ...filters, tag: null, tab: 'relevance' as const };
  const result = await loadPool({ ...query, q: shared });
  assert.deepEqual(result.items.map((i) => i.id), [id(2), id(1), id(3)], 'both fields score 4, direct scores 3, body scores 1');
  assert.equal(result.total, 3);
  for (const q of [direct, body]) {
    const side = await loadPool({ ...query, q });
    assert.deepEqual(side.items.map((i) => i.id), [id(4)]);
    assert.equal(side.total, 1);
  }
  const beyond = await loadPool({ ...query, q: shared, page: 50 });
  assert.deepEqual([beyond.items, beyond.total, beyond.pageCount], [[], 3, 1]);
  const empty = await loadPool({ ...query, q: `missing${tag()}` });
  assert.deepEqual([empty.items, empty.total], [[], 0]);
});

test('v1 search allows terms to match direct text and body, retaining time cursor order and public scope', async () => {
  const query = { mode: 'all' as const, window: '7d' as const, by: 'timeline' as const, category: null, q: `${T} bodyonly`, limit: 40, cursor: null };
  const first = await v1Items(query, now);
  const expected = Array.from({ length: 40 }, (_, i) => id(2104 - i * 2));
  assert.deepEqual(first.items.map((i) => i.id), expected);
  assert.equal(first.page.hasMore, true);
  const next = await v1Items({ ...query, cursor: first.page.nextCursor }, now);
  assert.equal(next.items[0]!.id, id(2024));
  const selected = await v1Items({ ...query, mode: 'selected', q: T }, now);
  assert.deepEqual(selected.items.map((i) => i.id), [id(2108)], 'selected direct matches do not require a pool_search row');
});

test('RSS summary excludes bodies; full RSS includes only licensed items', async () => {
  await sql`UPDATE publications SET selected = true, syndicate = true WHERE article_id = ${id(1)}`;
  const summary = await itemFeed('selected', null, { now });
  const full = await itemFeed('selected-full', null, { now });
  assert.ok(summary.includes(`<guid isPermaLink="false">${id(1)}</guid>`));
  assert.ok(!summary.includes('<content:encoded>'));
  assert.ok(full.includes('licensed body'));
  await sql`UPDATE publications SET syndicate = false WHERE article_id = ${id(1)}`;
  const revoked = await itemFeed('selected-full', null, { now });
  // Restrict the assertion to this item's XML: unrelated fixtures may legitimately syndicate.
  const item = revoked.split('<item>').find((i) => i.includes(`<guid isPermaLink="false">${id(1)}</guid>`))!;
  assert.ok(!item.includes('<content:encoded>'));
});

test('report directory projection preserves citation order, fallback headlines and absent historical citations', async () => {
  const content = { fixture: T, sections: [
    { label: 'first', items: [{ itemId: id(2106), title: 'Withdrawn first', summary: 'large unused summary' }] },
    { label: 'second', items: [{ itemId: `${T}-historical`, title: 'Historical fallback' }, { itemId: id(2), title: 'Third item' }] },
  ] };
  const key = `2097-12-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
    VALUES ('daily', ${key}, ${now}, ${now}, ${sql.json(content)}, ${now}, 'manual')`;
  const row = (await reportIndexRows('daily', 400)).find((r) => r.key === key)!;
  assert.ok(!JSON.stringify(row.content).includes('large unused summary'));
  assert.equal(issueLead(row.content, 'daily', await unavailableIds([id(2106)]))?.title, 'Historical fallback');
  const entry = (await listReports('daily')).find((r) => r.key === key)!;
  assert.deepEqual([entry.title, entry.count], ['Historical fallback', 3]);
  const full = (await app.inject({ method: 'GET', url: '/api/site/reports/daily' })).json().items;
  const navigation = (await app.inject({ method: 'GET', url: `/api/site/reports/daily/navigation/${key}` })).json().items;
  assert.deepEqual(navigation.map((e: { key: string }) => e.key), full.map((e: { key: string }) => e.key), 'all keys preserve issue numbers and calendar marks');
  assert.ok(navigation.every((e: object) => !('generatedAt' in e) && !('count' in e)));
  const month = (await app.inject({ method: 'GET', url: `/api/site/reports/daily/months/${key.slice(0, 7)}` })).json().items;
  assert.equal(month.find((e: { key: string }) => e.key === key).title, 'Historical fallback');
});

test('unchanged pool and timeline revalidate with 304 while a content change returns a new body', async () => {
  for (const path of [`/api/site/pool?tag=${T}`, `/api/site/timeline?tag=${T}`]) {
    const first = await app.inject({ method: 'GET', url: path });
    assert.equal(first.statusCode, 200, path);
    await new Promise((resolve) => setTimeout(resolve, 3));
    const same = await app.inject({ method: 'GET', url: path, headers: { 'if-none-match': String(first.headers.etag) } });
    assert.equal(same.statusCode, 304, path);
    assert.equal(same.body, '');
    await sql`UPDATE publications SET title = title || ' edited', updated_at = now() WHERE article_id = ${id(1)}`;
    const changed = await app.inject({ method: 'GET', url: path, headers: { 'if-none-match': String(first.headers.etag) } });
    assert.equal(changed.statusCode, 200, path);
  }
});
