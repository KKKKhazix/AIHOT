// MCP answers only requests addressed to this site (SITE_URL, MCP_ALLOWED_HOSTS and localhost): the
// Host, or the forwarded host, is parsed whole (one host and an optional port); anything malformed,
// empty, repeated or foreign is refused before the request is read.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import Fastify from "fastify";
import { registerMcp } from "../apps/api/src/routes/mcp.ts";

const initialize = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "host-test", version: "1.0.0" } },
};

for (const headers of [
  { host: "localhost" },
  { host: "LOCALHOST:65535" },
  { host: "127.0.0.1" },
  { host: "127.0.0.1:3001" },
  { host: "[::1]:0" },
  { host: "[::1]:00080" },
  { host: "[::1]" },
  { host: "[::1]:3001" },
  { host: "[0:0:0:0:0:0:0:1]:3001" },
  { host: "127.0.0.1:3001", "x-forwarded-host": "[::1]:3000" },
]) {
  test(`MCP initializes through ${JSON.stringify(headers)}`, async () => {
    const app = Fastify();
    registerMcp(app);
    try {
      const response = await app.inject({
        method: "POST", url: "/api/mcp", payload: initialize,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.headers["content-type"]?.startsWith("text/event-stream")
        ? JSON.parse(response.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6))
        : response.json();
      assert.equal(body.id, 1);
      assert.equal(body.result.protocolVersion, "2025-03-26");
      assert.equal(typeof body.result.serverInfo.name, "string");
      assert.equal(response.headers["cache-control"], "no-store");
    } finally {
      await app.close();
    }
  });
}

const app = Fastify();
registerMcp(app);
after(() => app.close());

function post(headers: Record<string, string | string[]>) {
  return app.inject({
    method: "POST", url: "/api/mcp", payload: initialize,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  });
}

function assertDenied(response: Awaited<ReturnType<typeof post>>, status = 421) {
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(response.json(), { error: status === 421 ? "misdirected_request" : "origin_not_allowed" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
}

test("MCP rejects malformed or disallowed Host and forwarded authorities", async () => {
  const authorities = [
    "", "evil.invalid", "localhost.evil.invalid", "localhost.", "127.0.0.1.", "127.1", "2130706433", "0x7f000001", "0177.0.0.1",
    "evil@localhost", "localhost@evil.invalid", "user:password@localhost", "localhost/path", "localhost\\path", "localhost?query", "localhost#fragment",
    " localhost", "localhost ", "local host", "localhost\t", "localhost\n", "localhost\r", "localhost\0", "localhost\x7f",
    "localhost,evil.invalid", "localhost, localhost", "::1", "::1:3001", "[::1", "::1]", "[[::1]]", "[::1]extra", "[::g]", "[localhost]", "[]",
    "[fe80::1%25lo0]", "%6cocalhost", "127.0.0.%31", "http://localhost", "localhost:", "localhost:-1", "localhost:+80", "localhost:1.5",
    "localhost:abc", "localhost:65536", "localhost:99999999999999999999999", "localhost:80:90", "[::1]:", "[::1]:abc", "[::1]:65536",
  ];
  for (const authority of authorities) {
    const requests: Array<Record<string, string>> = [{ host: "localhost", "x-forwarded-host": authority }];
    if (authority) requests.push({ host: authority });
    for (const headers of requests) {
      const response = await post(headers);
      assert.equal(response.statusCode, 421, `${JSON.stringify(headers)}: ${response.body}`);
      assertDenied(response);
    }
  }
  for (const authority of [["localhost", "evil.invalid"], ["[::1]", "localhost"], []]) {
    assertDenied(await post({ host: "localhost", "x-forwarded-host": authority }));
  }
});

function rawRequest(address: string, authorityHeaders: string[], method = "POST") {
  return new Promise<{ status: number | undefined; body: string; cache: string | undefined }>((resolve, reject) => {
    const req = request(`${address}/api/mcp`, {
      method, setHost: false, headers: [...authorityHeaders, ...(method === "POST" ? ["Content-Type", "application/json"] : []), "Accept", "application/json, text/event-stream"],
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, cache: res.headers["cache-control"] }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(method === "POST" ? JSON.stringify(initialize) : undefined);
  });
}

test("MCP rejects an empty Host received over HTTP", async () => {
  // Injected requests turn an empty Host into localhost, so this one goes over real HTTP.
  const server = Fastify();
  registerMcp(server);
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const response = await rawRequest(address, ["Host", ""]);
    assert.equal(response.status, 421, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: "misdirected_request" });
    assert.equal(response.cache, "no-store");
  } finally {
    await server.close();
  }
});

test("MCP rejects repeated effective authority headers over HTTP", async () => {
  // Raw header fields: injection would merge repeated Host values and hide which one Node keeps.
  const server = Fastify();
  registerMcp(server);
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    for (const headers of [
      ["Host", "[::1]", "Host", "evil.invalid"],
      ["Host", "localhost", "Host", "localhost"],
      ["Host", "localhost", "hOsT", "evil.invalid"],
      ["Host", "evil.invalid", "Host", "localhost"],
      ["Host", "localhost", "X-Forwarded-Host", "[::1]", "X-Forwarded-Host", "[::1]"],
      ["Host", "localhost", "X-Forwarded-Host", "[::1]", "x-forwarded-host", "evil.invalid"],
    ]) {
      const response = await rawRequest(address, headers);
      assert.equal(response.status, 421, `${JSON.stringify(headers)}: ${response.body}`);
      assert.deepEqual(JSON.parse(response.body), { error: "misdirected_request" });
      assert.equal(response.cache, "no-store");
    }
    const forwarded = await rawRequest(address, ["Host", "evil.invalid", "Host", "localhost", "X-Forwarded-Host", "[::1]"]);
    assert.equal(forwarded.status, 200, forwarded.body);
    const preflight = await rawRequest(address, ["Host", "localhost", "Host", "evil.invalid", "Origin", "http://localhost:3000"], "OPTIONS");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.cache, "no-store");
  } finally {
    await server.close();
  }
});

test("MCP keeps forwarded Host precedence", async () => {
  const response = await post({ host: "evil.invalid", "x-forwarded-host": "[::1]:3000" });
  assert.equal(response.statusCode, 200, response.body);
  assertDenied(await post({ host: "[::1]", "x-forwarded-host": "evil.invalid" }));
});

test("MCP keeps localhost and IPv4 Origins while rejecting unconfigured IPv6 and other Origins", async () => {
  for (const host of ["127.0.0.1:3001", "[::1]:3001"]) {
    for (const origin of ["http://localhost:3000", "https://localhost:3443", "http://127.0.0.1:3000"]) {
      const response = await post({ host, origin });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["access-control-allow-origin"], origin);
      assert.equal(response.headers.vary, "Origin");
      assert.match(response.headers["access-control-expose-headers"] ?? "", /MCP-Protocol-Version/);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    for (const origin of ["http://[::1]:3000", "https://evil.invalid", "not-an-origin"]) {
      assertDenied(await post({ host, origin }), 403);
    }
  }
});

test("MCP preserves preflight, unsupported methods, and shared GET/DELETE Host checks", async () => {
  for (const host of ["127.0.0.1:3001", "[::1]:3001", "evil.invalid"]) {
    const response = await app.inject({ method: "OPTIONS", url: "/api/mcp", headers: { host, origin: "http://localhost:3000" } });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-origin"], "http://localhost:3000");
    assert.equal(response.headers["access-control-allow-methods"], "POST, GET, DELETE, OPTIONS");
    assert.equal(response.headers["cache-control"], "no-store");
    assertDenied(await app.inject({ method: "OPTIONS", url: "/api/mcp", headers: { host, origin: "https://evil.invalid" } }), 403);
    for (const method of ["PUT", "PATCH"] as const) {
      const unsupported = await app.inject({ method, url: "/api/mcp", headers: { host } });
      assert.equal(unsupported.statusCode, 405);
      assert.equal(unsupported.headers["cache-control"], "no-store");
    }
  }
  for (const method of ["GET", "DELETE"] as const) {
    const request = { method, url: "/api/mcp", headers: { host: "127.0.0.1", accept: "application/json, text/event-stream" } };
    const ipv4 = await app.inject(request);
    const ipv6 = await app.inject({ ...request, headers: { ...request.headers, host: "[::1]" } });
    assert.equal(ipv6.statusCode, ipv4.statusCode);
    assert.equal(ipv6.body, ipv4.body);
    assert.equal(ipv6.headers["cache-control"], "no-store");
    assertDenied(await app.inject({ ...request, headers: { ...request.headers, host: "evil.invalid" } }));
  }
  const batch = await app.inject({ method: "POST", url: "/api/mcp", headers: { host: "[::1]" }, payload: [initialize] });
  assert.equal(batch.statusCode, 400);
  assert.equal(batch.json().error.message, "Batch requests are not supported");
  assert.equal(batch.headers["cache-control"], "no-store");
});

function checkConfiguration(siteUrl: string, allowedHosts: string, cases: Array<{ headers: Record<string, string>; status: number }>) {
  // A process of its own sets the configuration before the route loads (the module reads it once).
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import Fastify from "fastify";
    import { registerMcp } from "./apps/api/src/routes/mcp.ts";
    const app = Fastify();
    registerMcp(app);
    try {
      for (const { headers, status } of JSON.parse(process.argv[1])) {
        const response = await app.inject({ method: "POST", url: "/api/mcp", payload: ${JSON.stringify(initialize)},
          headers: { accept: "application/json, text/event-stream", ...headers } });
        assert.equal(response.statusCode, status, JSON.stringify(headers) + ": " + response.body);
        assert.equal(response.headers["cache-control"], "no-store");
      }
    } finally { await app.close(); }
  `, JSON.stringify(cases)], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10000,
    env: { ...process.env, SITE_URL: siteUrl, MCP_ALLOWED_HOSTS: allowedHosts },
  });
}

test("MCP normalizes only explicitly configured site and extra host authorities", () => {
  checkConfiguration("https://site.example:8443", "EXTRA.EXAMPLE:8080, [2001:0db8:0:0:0:0:0:1]:3000, evil@localhost, bad.example/path, broken.example:65536", [
    { headers: { host: "site.example:3001", origin: "https://site.example:8443" }, status: 200 },
    { headers: { host: "SITE.EXAMPLE:3001" }, status: 200 },
    { headers: { host: "extra.example" }, status: 200 },
    { headers: { host: "extra.example:9090" }, status: 200 },
    { headers: { host: "[2001:db8::1]:3001" }, status: 200 },
    { headers: { host: "[2001:DB8::1]" }, status: 200 },
    { headers: { host: "[2001:db8::2]" }, status: 421 },
    { headers: { host: "extra.example." }, status: 421 },
    { headers: { host: "extra.example.evil.invalid" }, status: 421 },
    { headers: { host: "bad.example" }, status: 421 },
    { headers: { host: "broken.example" }, status: 421 },
    { headers: { host: "127.1" }, status: 421 },
    { headers: { host: "[::1]", origin: "http://[::1]:3000" }, status: 403 },
    { headers: { host: "extra.example", origin: "https://extra.example" }, status: 403 },
  ]);
});

test("MCP retains an IPv6 site's existing matching-Origin allowance", () => {
  checkConfiguration("http://[::1]:3000", "", [
    { headers: { host: "[::1]:3001", origin: "http://[::1]:3000" }, status: 200 },
    { headers: { host: "[0:0:0:0:0:0:0:1]:3001", origin: "http://[0:0:0:0:0:0:0:1]:3000" }, status: 200 },
    { headers: { host: "[::1]:3001", origin: "http://[::2]:3000" }, status: 403 },
  ]);
});

const ipv4Aliases = ["127.1", "2130706433", "0x7f000001", "0177.0.0.1"];
for (const alias of ipv4Aliases) {
  test(`MCP preserves explicitly configured IPv4 spelling ${alias}`, () => {
    checkConfiguration("https://site.example", alias, [
      { headers: { host: alias }, status: 200 },
      { headers: { host: `${alias}:3001` }, status: 200 },
      { headers: { host: "localhost", "x-forwarded-host": alias }, status: 200 },
      ...ipv4Aliases.filter((other) => other !== alias).map((host) => ({ headers: { host }, status: 421 })),
    ]);
  });
}
