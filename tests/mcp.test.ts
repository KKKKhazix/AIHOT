import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOLS } from "@aihot/contracts/mcp";
import { registerMcp } from "../apps/api/src/routes/mcp.ts";

test("closing the API drains a live MCP subscription before closing HTTP", { timeout: 5000 }, async () => {
  const app = Fastify();
  registerMcp(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
      notifications: { toolsListChanged: true },
    } }),
  });
  try {
    assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /acknowledged/);
    await app.close();
    while (!(await reader.read()).done) { /* consume the SDK's graceful-close result */ }
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});

// The SDK advertises tools.listChanged unless told otherwise, and a 2026-07-28 client that handles list
// changes then keeps a listen stream open for its whole session: an idle connection per agent.
test("an MCP client with a list-changed handler opens no listen stream", { timeout: 5000 }, async () => {
  const app = Fastify();
  const methods: string[] = [];
  app.addHook("onRequest", async (req) => { methods.push(String(req.headers["mcp-method"] ?? req.method)); });
  registerMcp(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "listen-check", version: "1.0.0" }, {
    listChanged: { tools: { onChanged: () => {} } },
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/api/mcp`)));
    assert.equal((await client.listTools()).tools.length, MCP_TOOLS.length);
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
    assert.equal(client.autoOpenedSubscription, undefined);
    assert.ok(!methods.includes("subscriptions/listen"), methods.join(","));
  } finally {
    await client.close();
    app.server.closeAllConnections();
    await app.close();
  }
});
