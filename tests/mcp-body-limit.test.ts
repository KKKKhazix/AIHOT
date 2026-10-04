// Failure cases: pre-parsed JSON bypasses the SDK's limit; insignificant whitespace disappears
// when JSON is re-serialized; multi-byte text is counted as characters; chunked input has no length.
import "./setup.ts";
import assert from "node:assert/strict";
import { request } from "node:http";
import { after, test } from "node:test";
import Fastify from "fastify";
import { registerMcp } from "../apps/api/src/routes/mcp.ts";
import { buildApp } from "../apps/api/src/app.ts";

const LIMIT = 256 * 1024;
const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
registerMcp(app);
after(() => app.close());
const headers = { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" };
const initialize = (name: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1.0.0" },
} });

test("MCP accepts a JSON body at its byte limit and refuses one byte over before parsing", async () => {
  const empty = initialize("");
  for (const extra of [0, 1]) {
    const payload = initialize("a".repeat(LIMIT - Buffer.byteLength(empty) + extra));
    assert.equal(Buffer.byteLength(payload), LIMIT + extra);
    const response = await app.inject({ method: "POST", url: "/api/mcp", headers, payload });
    assert.equal(response.statusCode, extra ? 413 : 200);
  }
});

test("MCP counts raw whitespace in its body limit", async () => {
  const payload = `${initialize("small")}\n${" ".repeat(LIMIT)}`;
  const response = await app.inject({ method: "POST", url: "/api/mcp", headers, payload });
  assert.equal(response.statusCode, 413);
});

test("MCP bounds UTF-8 bytes rather than JavaScript string length", async () => {
  const payload = initialize("字".repeat(90_000));
  assert.ok(payload.length < LIMIT && Buffer.byteLength(payload) > LIMIT);
  const response = await app.inject({ method: "POST", url: "/api/mcp", headers, payload });
  assert.equal(response.statusCode, 413);
});

test("MCP refuses an oversized chunked body without Content-Length", async () => {
  const local = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  registerMcp(local);
  const address = await local.listen({ host: "127.0.0.1", port: 0 });
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${address}/api/mcp`, { method: "POST", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.write(initialize("small"));
      req.end(" ".repeat(LIMIT));
    });
    assert.equal(status, 413);
  } finally {
    await local.close();
  }
});

// A parser refusal happens before the handler: it must still be an uncached MCP error that a
// permitted browser can read, without reflecting an unapproved browser origin.
test("oversized MCP requests preserve JSON-RPC, no-store and the Origin policy", async () => {
  const api = await buildApp();
  try {
    for (const origin of ["http://localhost:3000", "https://unapproved.example"]) {
      const response = await api.inject({ method: "POST", url: "/api/mcp", headers: { ...headers, origin }, payload: `${initialize("small")}${" ".repeat(LIMIT)}` });
      assert.equal(response.statusCode, 413);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["access-control-allow-origin"], origin.startsWith("http://localhost") ? origin : undefined);
      assert.deepEqual(response.json(), { jsonrpc: "2.0", error: { code: -32000, message: "MCP request body is too large." }, id: null });
    }
  } finally {
    await api.close();
  }
});
