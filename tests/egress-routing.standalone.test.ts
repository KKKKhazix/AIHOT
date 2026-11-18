// Failures: domestic feeds inherit the proxy's overseas DNS/CDN; a host exception leaks to
// unrelated domains or redirect targets; choosing a direct route bypasses the private-address guard.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { DEPLOYMENT } from "@aihot/site";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";

const deployment = DEPLOYMENT as unknown as { directFetchHosts?: string[] };
const previousHosts = deployment.directFetchHosts;
const previousProxy = config.egressProxyUrl;
const previousDns = config.egressDnsUpstreams;
const previousPrivate = config.allowPrivateNetworkFetch;
const previousDispatcher = getGlobalDispatcher();
const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
let proxyHits = 0;
const addresses: Record<string, string> = { "paid.invalid": "93.184.216.34", "internal.invalid": "127.0.0.1" };
function reply(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, "http://fallback");
  res.setHeader("connection", "close");
  if (url.pathname !== "/dns-query") {
    res.end(`${req.headers.host} ${req.headers.authorization}`);
    return;
  }
  const address = addresses[url.searchParams.get("name") ?? ""];
  res.end(JSON.stringify({ Status: address ? 0 : 3, Answer: address && url.searchParams.get("type") === "A" ? [{ type: 1, data: address, TTL: 30 }] : [] }));
}
const fallbackOrigin = createServer(reply);
const proxy = createServer((req, res) => {
  proxyHits++;
  reply(req, res);
});
proxy.on("connect", (req, socket, head) => {
  proxyHits++;
  if (req.url === "93.184.216.34:80") {
    const upstream = connect((fallbackOrigin.address() as AddressInfo).port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    return;
  }
  socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});
await Promise.all([proxy, fallbackOrigin].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
config.egressProxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
config.egressDnsUpstreams = ["http://test-dns.invalid/dns-query"];
config.allowPrivateNetworkFetch = true;
deployment.directFetchHosts = ["domestic.invalid", "localhost"];
after(async () => {
  deployment.directFetchHosts = previousHosts;
  config.egressProxyUrl = previousProxy;
  config.egressDnsUpstreams = previousDns;
  config.allowPrivateNetworkFetch = previousPrivate;
  setGlobalDispatcher(previousDispatcher);
  await mock.close();
  await Promise.all([proxy, fallbackOrigin].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

test("configured public host uses the direct transport without consulting proxy DNS", async () => {
  mock.get("https://domestic.invalid").intercept({ path: "/feed" }).reply(200, "feed");
  const before = proxyHits;
  assert.equal((await guardedFetch("https://domestic.invalid/feed", { timeoutMs: 1000 })).text(), "feed");
  assert.equal(proxyHits, before);
});

test("a redirect recalculates routing for its destination instead of inheriting the exception", async () => {
  mock.get("https://domestic.invalid").intercept({ path: "/move" }).reply(302, "", { headers: { location: "https://abroad.invalid/feed" } });
  const before = proxyHits;
  await assert.rejects(guardedFetch("https://domestic.invalid/move", { timeoutMs: 1000 }));
  assert.ok(proxyHits > before);
  assert.equal(mock.pendingInterceptors().some(i => i.path === "/move"), false, "the direct first hop was read");
});

test("the host list matches exact hostnames and explicit direct callers still work", async () => {
  const before = proxyHits;
  await assert.rejects(guardedFetch("https://domestic.invalid.evil.invalid/feed", { timeoutMs: 1000 }));
  assert.ok(proxyHits > before);
  mock.get("https://paid.invalid").intercept({ path: "/api" }).reply(200, "api");
  assert.equal((await guardedFetch("https://paid.invalid/api", { route: "direct" })).text(), "api");
});

test("direct-first uses the proxy only when the first connection times out before the request", async () => {
  const paid = mock.get("https://paid.invalid");
  const options = { route: "direct-first" as const, timeoutMs: 1000, headers: { authorization: "Bearer test" } };
  const connectTimeout = () => Object.assign(new Error("connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  const before = proxyHits;
  paid.intercept({ path: "/ok" }).reply(200, "ok");
  assert.equal((await guardedFetch("https://paid.invalid/ok", options)).text(), "ok");
  paid.intercept({ path: "/provider-error" }).reply(522, "upstream timed out");
  assert.equal((await guardedFetch("https://paid.invalid/provider-error", options)).status, 522);
  paid.intercept({ path: "/misdirected" }).reply(421, "wrong connection");
  paid.intercept({ path: "/misdirected" }).replyWithError(connectTimeout());
  await assert.rejects(guardedFetch("https://paid.invalid/misdirected", options));
  assert.equal(proxyHits, before, "Undici's retry after a 421 cannot trigger a proxy replay");
  paid.intercept({ path: "/read-timeout" }).replyWithError(Object.assign(new Error("read timed out"), { code: "UND_ERR_HEADERS_TIMEOUT" }));
  await assert.rejects(guardedFetch("https://paid.invalid/read-timeout", options));
  paid.intercept({ path: "/redirect" }).reply(307, "", { headers: { location: "/target" } });
  paid.intercept({ path: "/target" }).replyWithError(connectTimeout());
  await assert.rejects(guardedFetch("https://paid.invalid/redirect", options));
  assert.equal(proxyHits, before);
  mock.get("http://paid.invalid").intercept({ path: "/connect-timeout" }).replyWithError(connectTimeout());
  const throughProxy = await guardedFetch("http://paid.invalid/connect-timeout", options);
  assert.equal(throughProxy.text(), "paid.invalid Bearer test", "fallback sent the request via the checked tunnel");
  mock.get("http://internal.invalid").intercept({ path: "/internal" }).replyWithError(connectTimeout());
  await assert.rejects(guardedFetch("http://internal.invalid/internal", options), { cause: new Error("Blocked proxy address for internal.invalid") });
});

test("direct host exceptions never grant permission to fetch a private address", async () => {
  config.allowPrivateNetworkFetch = false;
  try { await assert.rejects(guardedFetch("http://localhost/metadata"), /Blocked/); }
  finally { config.allowPrivateNetworkFetch = true; }
});
