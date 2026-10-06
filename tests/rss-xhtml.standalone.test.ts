// Atom text stays literal; XHTML keeps mixed text/element order before HTML cleaning.
import './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { config } from '@aihot/backend/config';
import { fetchRss } from '@aihot/backend/sources/rss';
import { escapeXml } from '@aihot/backend/lib/text';

const body = `<p>Before <strong>bold</strong>, between <em>italic</em>, after.</p><p>${'A complete research article with enough text for the feed body. '.repeat(8)}</p>`;
const xhtml = (html: string) => `<div xmlns="http://www.w3.org/1999/xhtml">${html}</div>`;
const pages: Record<string, string> = {
  '/title': `<title type="xhtml">${xhtml('New <em>research</em> result')}</title><summary type="xhtml">${xhtml('First <b>important</b> result, then another.')}</summary>`,
  '/html-title': '<title type="html">New &lt;em&gt;research&lt;/em&gt; result</title><summary type="html">First &lt;b&gt;important&lt;/b&gt; result, then another.</summary>',
  '/body': `<title>New result</title><content type="xhtml">${xhtml(body)}</content>`,
  '/html': `<title>New result</title><content type="html">${escapeXml(body)}</content>`,
  '/cdata': `<title>New result</title><content type="html"><![CDATA[${body}]]></content>`,
  '/unsafe': `<title>New result</title><content type="xhtml">${xhtml(`${body}<script>alert(1)</script><p><a href="javascript:alert(1)" onclick="alert(1)">Unsafe link</a> &lt;img src=x onerror=alert(1)&gt;</p>`)}</content>`,
};
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/atom+xml');
  res.end(`<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:test:feed</id><title>Test</title><updated>2026-09-29T00:00:00Z</updated><author><name>Test</name></author><entry><id>urn:test:entry</id><updated>2026-09-29T00:00:00Z</updated><link href="https://example.org/article"/>${pages[req.url!]}</entry></feed>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function read(path: string, summaryIsBody = false) {
  const feedUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`;
  return (await fetchRss({ config: { feedUrl, summaryIsBody }, participation_mode: 'editorial' } as never)).candidates;
}

test('Atom HTML and XHTML titles and summaries keep the article and its text in order', async () => {
  for (const path of ['/title', '/html-title']) {
    const items = await read(path);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, 'New research result');
    assert.equal(items[0]!.excerpt, 'First important result, then another.');
  }
});

test('Atom XHTML bodies match escaped HTML and CDATA without losing mixed-content order', async () => {
  const [item] = await read('/body');
  assert.equal(item!.bodyStatus, 'ok');
  assert.match(item!.bodyHtml!, /Before <strong>bold<\/strong>, between <em>italic<\/em>, after\./);
  for (const path of ['/html', '/cdata']) {
    const [control] = await read(path);
    assert.equal(item!.bodyHtml, control!.bodyHtml);
    assert.equal(item!.bodyText, control!.bodyText);
  }
});

test('Atom XHTML still passes through HTML sanitization without decoding escaped markup twice', async () => {
  const [item] = await read('/unsafe');
  assert.equal(item!.bodyStatus, 'ok');
  assert.doesNotMatch(item!.bodyHtml!, /<script|<img|javascript:|onclick=/);
  assert.ok(item!.bodyHtml!.includes('&lt;img'), 'escaped markup remains text');
});

for (const type of ['', ' type="text"']) {
  const label = type ? 'explicit' : 'default';
  const title = '<dialog>';
  const summary = 'Use <model> & keep &lt;literal&gt; unchanged.';
  const plainBody = `${summary} <script>alert(1)</script> <img src="https://example.org/literal.png"> ${'Article text. '.repeat(30)}`;
  pages[`/${label}-text`] = `<title${type}>${escapeXml(title)}</title><summary${type}>${escapeXml(summary)}</summary><content${type}>${escapeXml(plainBody)}</content>`;
  pages[`/${label}-summary`] = `<title>Summary article</title><summary${type}>${escapeXml(summary)}</summary>`;

  test(`Atom ${label} text preserves literal markup and entities without creating HTML or media`, async () => {
    const items = await read(`/${label}-text`);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.title, title);
    assert.equal(item.excerpt, summary);
    assert.equal(item.bodyStatus, 'ok');
    assert.equal(item.bodyText, plainBody.trim());
    assert.ok(item.bodyHtml!.includes('&lt;script&gt;'));
    assert.ok(item.bodyHtml!.includes('&amp;lt;literal&amp;gt;'));
    assert.doesNotMatch(item.bodyHtml!, /<script|<img/);
    assert.deepEqual(item.media, []);
  });

  test(`Atom ${label} text summary is preserved both as an excerpt and an optional body`, async () => {
    const [excerpt] = await read(`/${label}-summary`);
    assert.equal(excerpt!.excerpt, summary);
    assert.equal(excerpt!.bodyStatus, 'pending');
    assert.equal(excerpt!.bodyHtml, null);
    const [article] = await read(`/${label}-summary`, true);
    assert.equal(article!.excerpt, summary);
    assert.equal(article!.bodyStatus, 'ok');
    assert.equal(article!.bodyText, summary);
    assert.ok(article!.bodyHtml!.includes('&lt;model&gt;'));
  });
}
