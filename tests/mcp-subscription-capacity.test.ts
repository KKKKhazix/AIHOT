// A separate SDK instance per listener makes its 1024-subscription ceiling apply to each connection
// instead of the server. Clients must still receive the existing resource-limit error at that ceiling.
import './setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { registerMcp } from '../apps/api/src/routes/mcp.ts';

test('concurrent listeners retain the SDK subscription ceiling', { timeout: 30000 }, async () => {
  const app = Fastify(); registerMcp(app);
  let lastSocket: Socket | undefined;
  app.addHook('preHandler', async req => { if ((req.body as { id?: unknown })?.id === 1023) lastSocket = req.raw.socket; });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const open = (id: number) => fetch(`${address}/api/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
      notifications: { toolsListChanged: true },
    } }),
  });
  try {
    for (let start = 0; start < 1024; start += 32) {
      await Promise.all(Array.from({ length: 32 }, async (_, i) => {
        const response = await open(start+i);
        assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
        const reader = response.body!.getReader(); readers.push(reader);
        assert.match(new TextDecoder().decode((await reader.read()).value), /acknowledged/);
      }));
    }
    const limited = await open(1024);
    if (limited.headers.get('content-type')?.startsWith('text/event-stream')) {
      const reader = limited.body!.getReader(); readers.push(reader); await reader.read();
      assert.fail('a separate handler must not make every new connection its first subscription');
    }
    assert.equal((await limited.json()).error.code, -32603);
    const closed = once(lastSocket!, 'close');
    await readers.pop()!.cancel(); await closed;
    const resumed = await open(1025);
    assert.match(resumed.headers.get('content-type') ?? '', /text\/event-stream/, 'closing one listener releases one place');
    const reader = resumed.body!.getReader(); readers.push(reader); await reader.read();
    const stillLimited = await open(1026);
    if (stillLimited.headers.get('content-type')?.startsWith('text/event-stream')) {
      const extra = stillLimited.body!.getReader(); readers.push(extra); await extra.read();
      assert.fail('closing one peer must leave the other 1023 subscriptions active');
    }
    assert.equal((await stillLimited.json()).error.code, -32603);
  } finally {
    await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
    app.server.closeAllConnections(); await app.close();
  }
});
