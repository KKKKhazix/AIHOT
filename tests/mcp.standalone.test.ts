import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOLS } from "@aihot/contracts/mcp";
import { registerMcp } from "../apps/api/src/routes/mcp.ts";

// The SDK advertises tools.listChanged unless told otherwise, and a 2026-07-28 client that handles list
// changes then keeps a listen stream open for its whole session: an idle connection per agent. A client
// that listens anyway gets the protocol's answer for a method the server does not implement, at once.
test("an MCP client opens no listen stream, and one that asks is refused at once", { timeout: 5000 }, async () => {
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

    await assert.rejects(client.listen({ toolsListChanged: true }));
    const response = await fetch(`${address}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "listen-1", method: "subscriptions/listen", params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
        notifications: { toolsListChanged: true },
      } }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: "listen-1", error: { code: -32601, message: "Method not found" } });
    assert.equal((await client.listTools()).tools.length, MCP_TOOLS.length, "ordinary calls are unaffected");
  } finally {
    await client.close();
    app.server.closeAllConnections();
    await app.close();
  }
});
