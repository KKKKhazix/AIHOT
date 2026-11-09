// Observed nonexistent share-card names and decoded controls must not become server errors. A page link pasted into
// prose that swallowed the text after it ("…/agent。") goes to the page it meant.
// Failure modes: such a reader lands on a 404; the Location carries an unescaped character and the server answers 500,
// or an escape turns into a separator (%23); the cut leaves the site (//host) or climbs a dot segment; a real page,
// its .data, a slug in another script or an alias with its own rule is redirected; an API path answers anything but
// itself.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { closeDb } from '@aihot/backend/db';
import { resolveRedirect } from '@aihot/contracts/http-policy';
import { registerOg } from '../apps/api/src/routes/og.ts';
import { startWebServer, type WebServer } from '../apps/web/tests/web-server.ts';

const app = Fastify();
registerOg(app);
let web: WebServer;
const api = createServer((_req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'not_found' }));
});
before(async () => { web = await startWebServer(api); });
after(async () => { await app.close(); await closeDb(); await web?.stop(); });

test('inherited object names are nonexistent share cards', async () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '__defineGetter__', 'missing']) {
    const response = await app.inject(`/og/pages/${name}.png`);
    assert.equal(response.statusCode, 404, `${name}: ${response.body}`);
  }
});

test('ordinary share cards keep their PNG and conditional cache responses', async () => {
  const response = await app.inject('/og/pages/topics.png');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.deepEqual([...response.rawPayload.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  const cached = await app.inject({ url: '/og/pages/topics.png', headers: { 'if-none-match': response.headers.etag! } });
  assert.equal(cached.statusCode, 304);
});

test('decoded controls in topic paths cut the path there without injecting response headers', async () => {
  for (const [slug, page] of [['abc%0D%0AX-Evil:1', '/topics/abc'], ['abc%0A', '/topics/abc'], ['abc%0D', '/topics/abc'],
    ['abc%0A%09X-Evil:1', '/topics/abc'], ['%0AX-Evil:1', '/topics/']]) {
    for (const suffix of ['', '/page/1', '/page/2']) {
      const response = await fetch(`${web.origin}/topics/${slug}${suffix}`, { redirect: 'manual' });
      assert.equal(response.status, 301, `${slug}${suffix}: ${web.logs()}`);
      assert.equal(response.headers.get('x-evil'), null);
      assert.equal(response.headers.get('location'), page);
    }
  }
});

test('a page link that ran into the text after it goes to the page it meant, spelled as the request spelled it', async () => {
  // Shapes readers opened, percent-encoded as browsers send them.
  for (const [path, page] of [
    ['/agent%E3%80%82', '/agent'], // 。
    ['/agent%EF%BC%89', '/agent'], // ）
    ['/agent%E3%80%81', '/agent'], // 、
    ['/agent%EF%BC%8C%E5%8A%A0%E5%85%A5%E6%94%B6%E8%97%8F', '/agent'], // ，加入收藏
    ['/agent%E3%80%82%E2%80%8C', '/agent'], // 。 and a zero-width non-joiner
    ['/agent%E2%80%8C', '/agent'],
    ['/agent**', '/agent'],
    ['/agent**%EF%BC%88Example', '/agent'],
    ['/agent)', '/agent'],
    ["/agent'", '/agent'],
    ['/agent+', '/agent'],
    ['/agent.', '/agent'],
    ['/agent](https:/example.org/agent', '/agent'],
    ['/agent%5D(https:/example.org/agent', '/agent'],
    ['/daily%EF%BC%9A', '/daily'],
    ['/items/e80fmjdp23n217sd6e7ky52om%EF%BC%8C', '/items/e80fmjdp23n217sd6e7ky52om'],
    ['/topics/agent%E3%80%8B', '/topics/agent'],
    // What is kept keeps its escapes: letters of another script, and separators that would otherwise split the URL.
    ['/topics/%E6%99%BA%E8%83%BD%E4%BD%93%E3%80%82', '/topics/%E6%99%BA%E8%83%BD%E4%BD%93'], // 智能体。
    ['/agent%E7%A0%94%E7%A9%B6%E4%B8%8B%E3%80%82', '/agent%E7%A0%94%E7%A9%B6%E4%B8%8B'], // agent研究下。
    ['/items/abc%23%3F%E3%80%82', '/items/abc%23%3F'],
    ['/%61gent%E3%80%82', '/%61gent'],
  ]) {
    const response = await fetch(`${web.origin}${path}?utm_source=x`, { redirect: 'manual' });
    assert.equal(response.status, 301, `${path}: ${web.logs()}`);
    assert.equal(response.headers.get('location'), `${page}?utm_source=x`, path);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', `${path}: the Location repeats the reader's query`);
  }
});

test('real pages, their data, slugs in other scripts and aliases with their own rule are not cut', () => {
  for (const path of ['/', '//', '/agent', '/all.data', '/daily/2026-11-09', '/weekly/2026-W45', '/items/e80fmjdp23n217sd6e7ky52om',
    '/story/d01448e7-e6ef-4224-9e13-5f4b350dd6ed', '/topics/agent/page/2', '/topics/%E6%99%BA%E8%83%BD%E4%BD%93',
    // Text run on without punctuation is not guessed at: it may be a slug.
    '/agent%E7%A0%94%E7%A9%B6%E4%B8%8B']) {
    assert.equal(resolveRedirect(path, ''), null, path);
  }
  assert.equal(resolveRedirect('/all/', '')?.location, '/all');
});

test('the cut never leaves the site, climbs out of a path or writes what a header cannot carry', () => {
  for (const path of ['//evil.example%E3%80%82', '///evil.example%E3%80%82', '/%2F%2Fevil.example%E3%80%82', '/\\evil.example',
    '/%5C%5Cevil.example%E3%80%82']) {
    const location = resolveRedirect(path, '')?.location ?? '/';
    assert.match(location, /^\/(?![/\\])/, `${path} -> ${location}`);
  }
  for (const path of ['/items/..%E3%80%82', '/items/.%E3%80%82', '/items/%2E%2E%E3%80%82']) {
    const location = resolveRedirect(path, '')?.location ?? null;
    assert.ok(location === null || !/(^|\/)\.{1,2}(\/|$)/.test(location), `${path} -> ${location}`);
  }
  assert.equal(resolveRedirect('/agent%E3%80', ''), null, 'a malformed escape is left to the page');
  assert.equal(resolveRedirect('/topics/智能体。', ''), null, 'an unescaped letter is left to the page');
});

test('api paths answer as they are', () => {
  for (const path of ['/api/v1/items%EF%BC%8C', '/api/site/items%E3%80%82', '/api/mcp**']) assert.equal(resolveRedirect(path, ''), null, path);
});

test('ordinary first topic page keeps its permanent redirect', async () => {
  const response = await fetch(`${web.origin}/topics/openai/page/1`, { redirect: 'manual' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), '/topics/openai');
});
