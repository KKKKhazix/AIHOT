// Weekly and monthly reports must be discoverable from each machine access panel.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import * as cheerio from 'cheerio';
import { ENGLISH } from '@aihot/contracts/english';
import { MCP_TOOL_NAMES } from '@aihot/contracts/mcp';
import { fakeApi, startWebServer, type WebServer } from './web-server.ts';

let web: WebServer;
before(async () => { web = await startWebServer(fakeApi()); });
after(() => web.stop());

for (const [tab, names] of [
  ['rss', ['/feed/daily.xml', '/feed/weekly.xml', '/feed/monthly.xml']],
  ['api', ['/api/v1/dailies/latest', '/api/v1/weeklies/latest', '/api/v1/monthlies/latest']],
  ['mcp', [MCP_TOOL_NAMES.daily, MCP_TOOL_NAMES.weekly, MCP_TOOL_NAMES.monthly]],
] as const) {
  test(`the ${tab} panel exposes all report entry points`, async () => {
    const response = await fetch(`${web.origin}/agent?tab=${tab}`);
    assert.equal(response.status, 200, web.logs());
    const panel = cheerio.load(await response.text())('#agent-panel').text();
    for (const name of names) assert.ok(panel.includes(name), `${tab} panel omits ${name}`);
  });
}

test('English pages offer the English feeds: the RSS panel, every category row and the page head', { skip: ENGLISH === null }, async () => {
  const response = await fetch(`${web.origin}/en/agent?tab=rss`);
  assert.equal(response.status, 200, web.logs());
  const $ = cheerio.load(await response.text());
  const feeds = $('#agent-panel code').map((_, el) => $(el).text()).get().filter((text) => text.includes('/feed'));
  assert.ok(feeds.some((a) => a.endsWith('/en/feed.xml')) && feeds.some((a) => a.includes('/en/feed/full/category/')), feeds.join(' '));
  assert.deepEqual(feeds.filter((a) => !a.includes('/en/feed')), [], 'a feed address on an English page is an English feed');
  assert.equal($('link[rel="alternate"][type="application/rss+xml"]').attr('href'), '/en/feed.xml');
});

test('the English Agent page sends agents to the English guide and tells them how to ask MCP in English', { skip: ENGLISH === null }, async () => {
  const response = await fetch(`${web.origin}/en/agent`);
  assert.equal(response.status, 200, web.logs());
  const $ = cheerio.load(await response.text());
  assert.ok($('a[href="/api/v1/agent?lang=en"]').length > 0 && $('a[href="/api/v1/agent"]').length === 0, 'every guide link on it is the English guide');
  const mcp = cheerio.load(await (await fetch(`${web.origin}/en/agent?tab=mcp`)).text())('#agent-panel').text();
  assert.ok(mcp.includes('with lang "en"') && !mcp.includes('returns its summaries in Chinese'), mcp.slice(0, 300));
});
