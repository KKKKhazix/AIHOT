// Failure modes: identical simultaneous searches exhaust capacity, a shared answer crosses filters
// or clocks, completed/failed work stays cached, or distinct searches evade the capacity limit.
import { tag, gate } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { loadPool } from '@aihot/backend/publication/pool';
import { sharedSearch } from '@aihot/backend/lib/cache';
import { buildApp } from '../apps/api/src/app.ts';

const app = await buildApp();
const id = `search-share-${tag()}`;
const query = { channel: 'all' as const, category: null, tag: id, q: id, tab: 'relevance' as const };

before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${id},'Shared search','rss','T1','editorial')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${id},${id},${id},${`https://example.org/${id}`},${id},now(),now())`;
  await sql`INSERT INTO publications(article_id,source_id,url,title,summary,search_text,tags,category,channel,
    discovered_at,timeline_at,sort_at,eligible,selected,visible_after)
    VALUES(${id},${id},${`https://example.org/${id}`},${id},'search example',${id},${[id]},'ai-models','news',
      now(),now(),now(),true,false,now())`;
  await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${id},${id},'')`;
});
after(async () => { await app.close(); await closeDb(); });

async function blocked<T>(read: () => Promise<T>): Promise<T> {
  const ready = gate(); const release = gate();
  const lock = sql.begin(async tx => {
    await tx`LOCK TABLE pool_search IN ACCESS EXCLUSIVE MODE`;
    ready.open(); await release.promise;
  });
  await ready.promise;
  const pending = read();
  // Hold the first SQL while the concurrent requests reach the same unfinished read.
  await new Promise(resolve => setTimeout(resolve, 100));
  release.open(); await lock;
  return pending;
}

test('a burst of identical searches completes without consuming the distinct-search queue', async () => {
  for (const path of [`/api/site/pool?tag=${id}&q=${id}&tab=relevance`, `/api/v1/items?mode=all&window=7d&q=${id}`]) {
    const responses = await blocked(() => Promise.all(Array.from({ length: 20 }, () => app.inject(path))));
    assert.deepEqual(responses.map(r => r.statusCode), Array(20).fill(200), path);
    for (const response of responses) assert.deepEqual(response.json().items.map((i: { id: string }) => i.id), [id]);
  }
});

test('overlapping searches keep their category and explicit clock, and retain overload protection', async () => {
  const [models, other] = await blocked(() => Promise.all([
    loadPool({ ...query, category: 'ai-models' }), loadPool({ ...query, category: 'ai-products' }),
  ]));
  assert.deepEqual(models.items.map(i => i.id), [id]);
  assert.deepEqual(other.items, []);
  await sql`UPDATE publications SET selected=true,visible_after=now()+interval '1 day' WHERE article_id=${id}`;
  const [beforeRelease, afterRelease] = await blocked(() => Promise.all([
    loadPool({ ...query, now: new Date() }), loadPool({ ...query, now: new Date(Date.now()+2*86400000) }),
  ]));
  assert.deepEqual(beforeRelease.items, []);
  assert.deepEqual(afterRelease.items.map(i => i.id), [id]);
  await sql`UPDATE publications SET selected=false WHERE article_id=${id}`;
  const responses = await blocked(() => Promise.all(Array.from({ length: 20 }, (_, i) =>
    app.inject(`/api/site/pool?q=distinct${i}${id}&tab=relevance`))));
  assert.ok(responses.some(r => r.statusCode === 503));
  assert.ok(responses.filter(r => r.statusCode === 503).every(r => r.headers['retry-after'] === '5'));
});

test('completed work never hides a withdrawal and rejected work can be retried', async () => {
  assert.deepEqual((await loadPool(query)).items.map(i => i.id), [id]);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  assert.deepEqual((await loadPool(query)).items, []);
  await sql`ALTER TABLE pool_search RENAME TO unavailable_pool_search`;
  try { await assert.rejects(loadPool(query)); }
  finally { await sql`ALTER TABLE unavailable_pool_search RENAME TO pool_search`; }
  await sql`UPDATE publications SET visibility='public' WHERE article_id=${id}`;
  assert.deepEqual((await loadPool(query)).items.map(i => i.id), [id]);
});

test('unrelated completed or rejected searches cannot displace an unfinished shared read', async () => {
  for (const failing of [false, true]) {
    const release = gate();
    let reads = 0;
    const search = sharedSearch((key: string) => key, async (key) => {
      if (key === 'held') { reads++; await release.promise; return key; }
      if (failing) throw new Error('invalid unrelated search');
      return key;
    }, () => true);
    const first = search('held');
    await Promise.allSettled(Array.from({ length: 250 }, (_, i) => search(`unrelated-${i}`)));
    const next = search('held');
    release.open();
    assert.deepEqual(await Promise.all([first, next]), ['held', 'held']);
    assert.equal(reads, 1, 'settled searches must not force an identical unfinished query to run twice');
  }
});
