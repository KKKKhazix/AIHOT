// Production SSR with a local health stub. Failure case: machine entry points for weekly and monthly
// reports exist but cannot be found from the access page.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import * as cheerio from 'cheerio';
import { MCP_TOOL_NAMES } from '@aihot/contracts/mcp';
import { startWebServer, type WebServer } from './web-server.ts';

let web: WebServer;
const api = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true }));
  if (req.url === '/api/site/meta') return res.end(JSON.stringify({ changelogVersion: '2026-01-01T00:00' }));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: 'not_found' }));
});
before(async () => { web = await startWebServer(api); });
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
