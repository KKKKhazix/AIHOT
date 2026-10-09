// Discovery failure modes, specified before the implementation:
// - news activity invents lastmod dates for static pages, while corrections keep an old report date;
// - existing stories, translations, report corrections, withdrawals and merges are never notified;
// - unreleased selections or non-editorial sources leak into search discovery;
// - more than 10,000 changes at one timestamp are skipped or permanently starve later URLs;
// - dry runs, HTTP failures or module read failures acknowledge URLs that were never submitted;
// - the sitemap's display limits are mistaken for a removal from the full discovery inventory.
import './setup.ts';
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql, closeDb } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { installModules, type SitemapEntry } from '@aihot/backend/modules';
import { loadDiscoveryEntries } from '@aihot/backend/publication/sitemap';
import { submitIndexNow } from '@aihot/backend/operations/indexnow';

const originalFetch = globalThis.fetch;
const originalEnabled = config.indexNowSubmitEnabled;
const originalKey = config.indexNowKey;
after(closeDb);
afterEach(async () => {
  globalThis.fetch = originalFetch;
  config.indexNowSubmitEnabled = originalEnabled;
  config.indexNowKey = originalKey;
  installModules([]);
  await sql`DELETE FROM settings WHERE key = 'indexnow.watermark'`;
});

function capture(status = 200) {
  const batches: string[][] = [];
  config.indexNowSubmitEnabled = true;
  config.indexNowKey = '0123456789abcdef0123456789abcdef';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.indexnow.org/indexnow');
    batches.push(JSON.parse(String(init?.body)).urlList);
    return new Response('', { status });
  };
  return batches;
}

async function material(id: string, options: { source?: string; future?: boolean } = {}) {
  const source = options.source ?? 'discovery-editorial';
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${source},${source},'rss','T1',${source === 'discovery-signal' ? 'hot_signal' : 'editorial'}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,published_at,timeline_at,discovered_at,updated_at)
    VALUES (${id},${source},${id},${`https://example.org/${id}`},'公开报道','2026-10-01','2026-10-01','2026-10-01','2026-10-01')`;
  await sql`INSERT INTO publications (article_id,source_id,title,summary,url,timeline_at,discovered_at,sort_at,selected,eligible,indexable,visible_after,updated_at,channel,category)
    VALUES (${id},${source},'公开报道','公开摘要',${`https://example.org/${id}`},'2026-10-01','2026-10-01','2026-10-01',true,true,true,
      ${options.future ? '2100-01-01' : '2026-10-01'},'2026-10-01','news','ai-models')`;
}

test('discovery dates follow page content and publication scope', async () => {
  await material('dates-visible');
  await material('dates-future', { future: true });
  await material('dates-signal', { source: 'discovery-signal' });
  await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,updated_at)
    VALUES ('daily','2026-10-01','2026-09-30','2026-10-01','{}','2026-10-01T00:00:00Z','2026-10-04T00:00:00Z')`;
  const entries = await loadDiscoveryEntries(new Date('2026-10-09'));
  for (const loc of ['/', '/all', '/hot', '/agent', '/changelog']) {
    assert.equal(entries.find(e => e.loc === loc)?.lastmod, undefined, `${loc} must not borrow the news clock`);
  }
  assert.equal(entries.find(e => e.loc === '/daily/2026-10-01')?.lastmod?.toISOString(), '2026-10-04T00:00:00.000Z');
  assert.ok(entries.some(e => e.loc === '/items/dates-visible'));
  assert.ok(!entries.some(e => e.loc === '/items/dates-future'));
  assert.ok(!entries.some(e => e.loc === '/items/dates-signal'));
});

test('dry runs leave changes pending, corrections and disappeared URLs are submitted again', async () => {
  await material('changed-story-item');
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id,title,created_at,updated_at) VALUES (${publicId},'事件','2026-10-01','2026-10-01') RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,story_id,title) VALUES (${randomUUID()},${story!.id},'事实') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},'changed-story-item','primary')`;
  config.indexNowSubmitEnabled = false;
  globalThis.fetch = async () => { throw new Error('dry run made a network request'); };
  assert.equal((await submitIndexNow()).status, 'disabled');
  assert.equal((await sql`SELECT 1 FROM settings WHERE key='indexnow.watermark'`).length, 0);
  const batches = capture();
  assert.equal((await submitIndexNow()).status, 'sent');
  assert.ok(batches[0]!.some(url => url.endsWith(`/story/${publicId}`)));
  assert.equal((await submitIndexNow()).status, 'empty');
  await sql`UPDATE stories SET digest='已核实的新进展',digest_updated_at=now(),updated_at=now() WHERE id=${story!.id}`;
  await sql`UPDATE reports SET content='{"headline":"更正"}',revision=revision+1,updated_at=now() WHERE key='2026-10-01'`;
  await sql`INSERT INTO translations (article_id,revision,body_text,created_at) VALUES ('changed-story-item',1,'新的译文',now())`;
  await submitIndexNow();
  assert.ok(batches[1]!.some(url => url.endsWith(`/story/${publicId}`)), 'an existing story is updated');
  assert.ok(batches[1]!.some(url => url.endsWith('/items/changed-story-item')), 'a translation changes the public article');
  assert.ok(batches[1]!.some(url => url.endsWith('/daily/2026-10-01')), 'a corrected report is resubmitted');
  const [target] = await sql<{ id: number }[]>`INSERT INTO stories (public_id,title) VALUES (${randomUUID()},'存续事件') RETURNING id`;
  await sql`UPDATE stories SET merged_into=${target!.id},updated_at=now() WHERE id=${story!.id}`;
  await sql`UPDATE publications SET visibility='withdrawn',indexable=false,updated_at=now() WHERE article_id='changed-story-item'`;
  await submitIndexNow();
  assert.ok(batches[2]!.some(url => url.endsWith(`/story/${publicId}`)), 'an old merge URL needs a recrawl');
  assert.ok(batches[2]!.some(url => url.endsWith('/items/changed-story-item')), 'a withdrawn URL needs a recrawl');
  assert.equal((await submitIndexNow()).status, 'empty');
});

test('batches over the service limit make progress even when every change has the same timestamp', async () => {
  let entries: SitemapEntry[] = Array.from({ length: 10_005 }, (_, n) => ({ loc: `/bulk/${String(n).padStart(5, '0')}`, lastmod: new Date('2026-10-01') }));
  installModules([{ name: 'bulk', sitemap: { entries: async () => entries } }]);
  const batches = capture();
  const first = await submitIndexNow();
  assert.equal(first.urls, 10_000);
  assert.equal(first.more, true);
  const second = await submitIndexNow();
  assert.equal(second.more, false);
  assert.ok(second.urls > 0);
  const submitted = new Set(batches.flat());
  assert.equal([...submitted].filter(url => new URL(url).pathname.startsWith('/bulk/')).length, 10_005);
  assert.equal((await submitIndexNow()).status, 'empty');
  entries = entries.slice(1);
  await submitIndexNow();
  assert.ok(batches.at(-1)!.some(url => url.endsWith('/bulk/00000')));
});

test('failed requests and failed inventories never acknowledge a batch', async () => {
  capture(503);
  assert.equal((await submitIndexNow()).status, 'failed');
  assert.equal((await sql`SELECT 1 FROM settings WHERE key='indexnow.watermark'`).length, 0);
  globalThis.fetch = async () => { throw new Error('transport failed'); };
  await assert.rejects(submitIndexNow(), /transport failed/);
  assert.equal((await sql`SELECT 1 FROM settings WHERE key='indexnow.watermark'`).length, 0);
  const batches = capture(202);
  assert.equal((await submitIndexNow()).status, 'sent', 'accepted is a receipt, not proof of indexing');
  const [before] = await sql`SELECT value FROM settings WHERE key='indexnow.watermark'`;
  installModules([{ name: 'broken', sitemap: { entries: async () => { throw new Error('module read failed'); } } }]);
  await assert.rejects(submitIndexNow(), /module read failed/);
  const [after] = await sql`SELECT value FROM settings WHERE key='indexnow.watermark'`;
  assert.deepEqual(after!.value, before!.value);
  assert.equal(batches.length, 1);
});
