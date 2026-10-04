// Failure modes: indefinite subscriptions block nginx retirement; draining subscriptions cancels
// ordinary MCP calls; a subscription whose body finishes after the signal holds the old slot again.
import './setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import Fastify from 'fastify';
import { registerMcp } from '../apps/api/src/routes/mcp.ts';

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2026-07-28' };
const listen = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {
  _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
  notifications: { toolsListChanged: true },
} });
const tools = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {
  _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
} });

test('retiring subscriptions leaves pending and later ordinary MCP requests available', { timeout: 6000 }, async () => {
  const app = Fastify(); registerMcp(app);
  let accepted!: () => void;
  const begun = new Promise<void>(resolve => accepted = resolve);
  app.addHook('onRequest', async req => { if (req.headers['x-fixture'] === 'upload') accepted(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  let upload: ReturnType<typeof request> | undefined;
  try {
    const response = await fetch(`${address}/api/mcp`, { method: 'POST', headers: { ...headers, 'mcp-method': 'subscriptions/listen' }, body: listen });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /acknowledged/);
    const pending = new Promise<string>((resolve, reject) => {
      upload = request(`${address}/api/mcp`, { method: 'POST', headers: { ...headers, 'mcp-method': 'tools/list',
        'content-length': String(Buffer.byteLength(tools)), 'x-fixture': 'upload' } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(body));
      });
      upload.on('error', reject); upload.write(tools.slice(0, 1));
    });
    await begun;
    assert.equal(process.emit('SIGURG'), true, 'the API listens for subscription retirement');
    let final = ''; for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) final += new TextDecoder().decode(chunk.value);
    assert.match(final, /"resultType":"complete"/, 'subscriptions finish through the SDK protocol');
    upload!.end(tools.slice(1));
    assert.ok(JSON.parse(await pending).result.tools.length > 0);
    const ordinary = await fetch(`${address}/api/mcp`, { method: 'POST', headers: { ...headers, 'mcp-method': 'tools/list' }, body: tools });
    assert.equal(ordinary.status, 200); assert.ok((await ordinary.json()).result.tools.length > 0);
    const late = await fetch(`${address}/api/mcp`, { method: 'POST', headers: { ...headers, 'mcp-method': 'subscriptions/listen' }, body: listen });
    const lateText = await late.text();
    assert.equal(late.status, 200); assert.match(lateText, /acknowledged/); assert.match(lateText, /"resultType":"complete"/);
  } finally {
    upload?.destroy(); app.server.closeAllConnections(); await app.close();
  }
});
