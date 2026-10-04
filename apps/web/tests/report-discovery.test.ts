// Production SSR with a local health stub. Failure cases: an access page describes daily reports
// but omits weekly/monthly support; a report RSS card offers a schedule without saying it carries
// that issue's contents; machine entry points exist but cannot be found from the access page.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { MCP_TOOL_NAMES } from '@aihot/contracts/mcp';

let web: ChildProcess;
let origin: string;
let logs = '';
const api = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true }));
  if (req.url === '/api/site/meta') return res.end(JSON.stringify({ changelogVersion: '2026-01-01T00:00' }));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: 'not_found' }));
});
before(async () => {
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  web = spawn(process.execPath, [fileURLToPath(new URL('../server.ts', import.meta.url))], {
    env: { ...process.env, WEB_PORT: '0', API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on('exit', () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on('data', (chunk) => { logs += String(chunk); });
    web.stdout!.on('data', (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
  });
});
after(async () => {
  if (web && web.exitCode === null) { web.kill('SIGTERM'); await once(web, 'exit'); }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

async function page(tab: string) {
  const response = await fetch(`${origin}/agent?tab=${tab}`);
  assert.equal(response.status, 200, logs);
  return cheerio.load(await response.text());
}

test('the access page names every report cadence in its visible overview', async () => {
  const $ = await page('rss');
  const intro = $('h1').first().closest('header').find('p').first().text();
  for (const label of ['日报', '周报', '月报']) assert.ok(intro.includes(label), `access overview omits ${label}: ${intro}`);
});

test('all report RSS cards tell readers the feed includes an issue contents list', async () => {
  const $ = await page('rss');
  for (const kind of ['daily', 'weekly', 'monthly']) {
    const address = $(`code`).filter((_, node) => $(node).text().endsWith(`/feed/${kind}.xml`));
    assert.equal(address.length, 1, `${kind} RSS must be discoverable`);
    const description = address.closest('.card').find('p').text();
    assert.match(description, /目录|按栏目/, `${kind} RSS must describe its contents, not only its cadence`);
  }
});

for (const [tab, names] of [
  ['api', ['/api/v1/dailies/latest', '/api/v1/weeklies/latest', '/api/v1/monthlies/latest']],
  ['mcp', [MCP_TOOL_NAMES.daily, MCP_TOOL_NAMES.weekly, MCP_TOOL_NAMES.monthly]],
] as const) {
  test(`the ${tab} panel exposes all report entry points`, async () => {
    const $ = await page(tab);
    const panel = $('#agent-panel').text();
    for (const name of names) assert.ok(panel.includes(name), `${tab} panel omits ${name}`);
  });
}
