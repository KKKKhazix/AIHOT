// Baidu push failure modes, specified before the implementation:
// - the first run submits the whole existing site, or a later run submits a URL again (Baidu lowers the
//   quota or withdraws the interface for resubmissions);
// - a request asks for more than the day's remaining quota (over quota voids the rest of the day);
// - a dry run, a rejected request or a failed request acknowledges URLs Baidu never accepted, or a
//   failure after an accepted request forgets it, so a retry submits it again;
// - with a quota of a few URLs a day, single articles crowd out the day's report and stories, or an
//   old story crowds out a new one;
// - a new model-board page or topic, which answers searches for months and comes a few a week, waits behind
//   each day's news and never goes;
// - failures (a revoked token, an unverified site, Baidu down) pass as ordinary runs (the follow-up for a
//   day of them is in alerts.test.ts).
import './setup.ts';
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql, closeDb } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { installModules, type SitemapEntry } from '@aihot/backend/modules';
import { submitBaiduPush } from '@aihot/backend/operations/baidu-push';

const originalFetch = globalThis.fetch;
after(closeDb);
afterEach(async () => {
  globalThis.fetch = originalFetch;
  config.baiduPushEnabled = false;
  config.baiduPushToken = null;
  installModules([]);
  await sql`DELETE FROM settings WHERE key = 'baidu-push.state'`;
});

// 10:00, 11:00 and the next day 10:00 in Beijing.
const DAY1 = new Date('2026-10-09T02:00:00Z');
const DAY1_LATER = new Date('2026-10-09T03:00:00Z');
const DAY2 = new Date('2026-10-10T02:00:00Z');
const TOKEN = 'test-token-0123';

/** Baidu's push interface with a daily quota: each reply counts what it accepted and what is left today. */
function baidu(quota: number, reply?: (urls: string[]) => Response) {
  const requests: string[][] = [];
  let remain = quota;
  config.baiduPushEnabled = true;
  config.baiduPushToken = TOKEN;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    assert.equal(`${u.origin}${u.pathname}`, 'http://data.zz.baidu.com/urls');
    assert.equal(u.searchParams.get('site'), config.siteUrl);
    assert.equal(u.searchParams.get('token'), TOKEN);
    const urls = String(init?.body).split('\n').filter(Boolean);
    requests.push(urls);
    if (reply) return reply(urls);
    if (urls.length > remain) return Response.json({ error: 400, message: 'over quota' }, { status: 400 });
    remain -= urls.length;
    return Response.json({ success: urls.length, remain, not_same_site: [], not_valid: [] });
  };
  return { requests, newDay: (q: number) => { remain = q; } };
}

function pages(paths: () => string[]) {
  installModules([{ name: 'pages', sitemap: { entries: async () => paths().map((loc): SitemapEntry => ({ loc })) } }]);
}

const offline = () => {
  globalThis.fetch = async () => { throw new Error('made a network request'); };
};

test('the first run records the site as it is and submits nothing; later runs submit only new URLs, once', async () => {
  let paths = ['/p/old-1', '/p/old-2'];
  pages(() => paths);
  const { requests } = baidu(100);
  assert.equal((await submitBaiduPush(DAY1)).status, 'baseline');
  assert.equal(requests.length, 0, 'existing pages reach Baidu through the sitemap');
  assert.equal((await submitBaiduPush(DAY1)).status, 'empty');
  paths = [...paths, '/p/new'];
  assert.equal((await submitBaiduPush(DAY1_LATER)).status, 'sent');
  assert.deepEqual(requests.flat(), [`${config.siteUrl}/p/new`]);
  assert.equal((await submitBaiduPush(DAY1_LATER)).status, 'empty');
  assert.equal(requests.length, 1);
});

test('a dry run makes no request and acknowledges nothing', async () => {
  let paths = ['/p/old'];
  pages(() => paths);
  offline();
  assert.equal((await submitBaiduPush(DAY1)).status, 'baseline');
  paths = [...paths, '/p/new'];
  assert.equal((await submitBaiduPush(DAY1_LATER)).status, 'disabled');
  config.baiduPushEnabled = true;
  assert.equal((await submitBaiduPush(DAY1_LATER)).status, 'disabled', 'no token, nothing to send with');
  const { requests } = baidu(100);
  await submitBaiduPush(DAY1_LATER);
  assert.deepEqual(requests.flat(), [`${config.siteUrl}/p/new`]);
});

test('requests stay within the remaining quota and the rest waits for the next day', async () => {
  let paths: string[] = [];
  pages(() => paths);
  const { requests, newDay } = baidu(3);
  await submitBaiduPush(DAY1);
  paths = Array.from({ length: 5 }, (_, n) => `/p/${n}`);
  const first = await submitBaiduPush(DAY1_LATER);
  assert.equal(first.status, 'sent');
  assert.deepEqual(requests.map(r => r.length), [1, 2], 'one URL learns the quota left, then exactly that many');
  assert.equal(first.more, true);
  assert.equal((await submitBaiduPush(DAY1_LATER)).status, 'quota');
  assert.equal(requests.length, 2, 'no request once the day is used up');
  newDay(3);
  await submitBaiduPush(DAY2);
  const sent = requests.flat();
  assert.equal(new Set(sent).size, 5, 'nothing sent twice');
  assert.equal(sent.length, 5);
  assert.equal((await submitBaiduPush(DAY2)).status, 'empty');
});

test('rejected and failed requests acknowledge nothing', async () => {
  let paths = ['/p/old'];
  pages(() => paths);
  baidu(0);
  await submitBaiduPush(DAY1);
  paths = [...paths, '/p/new'];
  assert.equal((await submitBaiduPush(DAY1_LATER)).status, 'quota', 'over quota ends the day');
  const { requests: failed } = baidu(100, () => Response.json({ error: 505, message: 'please retry later' }, { status: 505 }));
  await assert.rejects(submitBaiduPush(DAY2), /505.*please retry later/);
  assert.equal(failed.length, 1);
  globalThis.fetch = async () => { throw new Error('transport failed'); };
  await assert.rejects(submitBaiduPush(DAY2), /transport failed/);
  const { requests } = baidu(100);
  assert.equal((await submitBaiduPush(DAY2)).status, 'sent');
  assert.deepEqual(requests.flat(), [`${config.siteUrl}/p/new`]);
});

test('what Baidu accepted stays accepted when a later request of the same run fails', async () => {
  let paths: string[] = [];
  pages(() => paths);
  baidu(5);
  await submitBaiduPush(DAY1);
  paths = ['/p/a', '/p/b', '/p/c'];
  const { requests: first } = baidu(5);
  const fetchBaidu = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (first.length) throw new Error('transport failed');
    return fetchBaidu(url, init);
  };
  await assert.rejects(submitBaiduPush(DAY1_LATER), /transport failed/);
  assert.equal(first.length, 1, 'the probe was accepted, the next request never arrived');
  const { requests: retry } = baidu(4);
  await submitBaiduPush(DAY1_LATER);
  assert.deepEqual(retry.map(r => r.length), [2], 'the remaining quota is known: no second probe, no resubmission');
  assert.equal(new Set([...first.flat(), ...retry.flat()]).size, 3);
});

test('a revoked token or an unverified site fails the run', async () => {
  let paths = ['/p/old'];
  pages(() => paths);
  baidu(100, () => Response.json({ error: 401, message: 'token is not valid' }, { status: 401 }));
  await submitBaiduPush(DAY1);
  paths = [...paths, '/p/new'];
  await assert.rejects(submitBaiduPush(DAY1_LATER), /401.*token is not valid/);
  baidu(100, () => Response.json({ error: 400, message: 'site error' }, { status: 400 }));
  await assert.rejects(submitBaiduPush(DAY1_LATER), /400.*site error/);
});

async function material(id: string, at: string) {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES ('baidu-editorial','baidu-editorial','rss','T1','editorial') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,published_at,timeline_at,discovered_at,updated_at)
    VALUES (${id},'baidu-editorial',${id},${`https://example.org/${id}`},'公开报道',${at},${at},${at},${at})`;
  await sql`INSERT INTO publications (article_id,source_id,title,summary,url,timeline_at,discovered_at,sort_at,selected,eligible,indexable,visible_after,updated_at,channel,category)
    VALUES (${id},'baidu-editorial','公开报道','公开摘要',${`https://example.org/${id}`},${at},${at},${at},true,true,true,${at},${at},'news','ai-models')`;
}

test('the report goes first, then pages that answer lasting searches, then stories and single articles, newer before older', async () => {
  const { requests } = baidu(100);
  let lasting: string[] = [];
  pages(() => lasting);
  await submitBaiduPush(DAY1);
  lasting = ['/about-new', '/topics/baidu-topic', '/leaderboard/prices'];
  await material('baidu-older', '2026-10-09T02:10:00Z');
  await material('baidu-older-also', '2026-10-09T02:10:00Z');
  await material('baidu-newer', '2026-10-09T02:20:00Z');
  await material('baidu-newer-also', '2026-10-09T02:20:00Z');
  // Public ids sort against their age, so only the stories' own order puts the newer first. Each gathers two
  // reports: a story of one has a noindex page and is never pushed.
  const story = async (publicId: string, articles: string[], latest: string) => {
    const [row] = await sql<{ id: number }[]>`INSERT INTO stories (public_id,title,latest_at,created_at,updated_at)
      VALUES (${publicId},'事件',${latest},${latest},${latest}) RETURNING id`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,story_id,title) VALUES (${randomUUID()},${row!.id},'事实') RETURNING id`;
    for (const article of articles) await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${article},'primary')`;
  };
  const olderStory = '00000000-0000-4000-8000-000000000000';
  const publicId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  await story(olderStory, ['baidu-older', 'baidu-older-also'], '2026-10-09T02:10:00Z');
  await story(publicId, ['baidu-newer', 'baidu-newer-also'], '2026-10-09T02:20:00Z');
  await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,updated_at)
    VALUES ('daily','2026-10-09','2026-10-08','2026-10-09','{}','2026-10-09T02:30:00Z','2026-10-09T02:30:00Z')`;
  await submitBaiduPush(DAY1_LATER);
  const sent = requests.flat().map(url => new URL(url).pathname);
  const at = (path: string) => sent.indexOf(path);
  assert.equal(sent[0], '/daily/2026-10-09', 'the one URL that learns the quota is the most valuable one');
  assert.ok(at('/leaderboard/prices') > 0 && at('/leaderboard/prices') < at('/topics/baidu-topic'));
  assert.ok(at('/topics/baidu-topic') < at(`/story/${publicId}`), 'pages for lasting searches before the day\'s news');
  assert.ok(at(`/story/${publicId}`) > 0);
  assert.ok(at(`/story/${publicId}`) < at(`/story/${olderStory}`), 'the newer story first');
  assert.ok(at(`/story/${olderStory}`) < at('/items/baidu-newer'));
  assert.ok(at('/items/baidu-newer') < at('/items/baidu-older'));
  assert.ok(at('/items/baidu-older') < at('/about-new'), 'any other page last');
});
