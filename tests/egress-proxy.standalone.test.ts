// Failure cases: a blocked local DNS holds every image in the lookup thread pool; a proxy resolves
// a checked name to an internal address; CONNECT loses the original HTTP host.
// Exercise real HTTP CONNECT requests against a local proxy before fixing.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { createEgressProxy, createEgressResolver } from "@aihot/backend/lib/egress-proxy";

// The MCP client has its own undici version; exercise the backend's actual HTTP implementation.
const { fetch } = createRequire(new URL("../packages/backend/package.json", import.meta.url))("undici");

const tunnels: string[] = [];
const origin = createServer((req, res) => res.end(req.headers.host));
const proxy = createServer();
proxy.on("connect", (req, socket, head) => {
  tunnels.push(req.url!);
  const upstream = net.connect((origin.address() as net.AddressInfo).port, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
});
await Promise.all([origin, proxy].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
after(async () => {
  await Promise.all([origin, proxy].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

// DNS-over-HTTPS upstreams on this machine, behind a forwarding proxy.
const asked = new Map<string, number>();
function upstream(answer: string) {
  return createServer((req, res) => {
    const query = new URL(req.url!, "http://dns").searchParams;
    const key = `${answer} ${query.get("name")}`;
    asked.set(key, (asked.get(key) ?? 0) + 1);
    res.setHeader("content-type", "application/dns-json");
    res.end(JSON.stringify({ Status: 0, Answer: query.get("type") === "A" ? [{ type: 1, data: answer, TTL: 30 }] : [] }));
  });
}
const unreachable = net.createServer((socket) => socket.destroy());
const publicDns = upstream("93.184.216.34");
const internalDns = upstream("10.0.0.5");
// Answers A with an internal address and fails AAAA.
const halfInternalDns = createServer((req, res) => {
  if (new URL(req.url!, "http://dns").searchParams.get("type") !== "A") { res.statusCode = 500; res.end(); return; }
  res.setHeader("content-type", "application/dns-json");
  res.end(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "10.0.0.6", TTL: 30 }] }));
});
const router = createServer((req, res) => {
  const forwarded = httpRequest(new URL(req.url!), { method: req.method, headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode!, answer.headers);
    answer.pipe(res);
  });
  forwarded.on("error", () => res.socket?.destroy());
  req.pipe(forwarded);
});
const dnsServers = [unreachable, publicDns, internalDns, halfInternalDns, router];
await Promise.all(dnsServers.map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
const local = (s: net.Server, path = "") => `http://127.0.0.1:${(s.address() as net.AddressInfo).port}${path}`;
after(async () => {
  await Promise.all(dnsServers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

test("egress resolves independently of local DNS and pins CONNECT while preserving Host", async () => {
  const agent = createEgressProxy(proxyUrl, async () => ["93.184.216.34"]);
  try {
    const res = await fetch("http://image.invalid:8080/photo", { dispatcher: agent });
    assert.equal(await res.text(), "image.invalid:8080");
    assert.equal(tunnels.at(-1), "93.184.216.34:8080");
  } finally { await agent.close(); }
});

test("internal, mixed, reserved, empty and malformed DNS answers never reach the proxy", async () => {
  for (const addresses of [["127.0.0.1"], ["93.184.216.34", "10.0.0.1"], ["::ffff:169.254.169.254"], ["2001:db8::1"], ["198.18.0.1"], ["198.19.255.255"], [], ["not-an-ip"]]) {
    const before = tunnels.length;
    const agent = createEgressProxy(proxyUrl, async () => addresses);
    try {
      await assert.rejects(fetch("http://image.invalid/photo", { dispatcher: agent }));
      assert.equal(tunnels.length, before);
    } finally { await agent.close(); }
  }
});

test("unpinned CONNECT carries the checked host name, and internal answers still never reach the proxy", async () => {
  const agent = createEgressProxy(proxyUrl, async () => ["93.184.216.34"], undefined, false);
  try {
    const res = await fetch("http://image.invalid:8080/photo", { dispatcher: agent });
    assert.equal(await res.text(), "image.invalid:8080");
    assert.equal(tunnels.at(-1), "image.invalid:8080");
  } finally { await agent.close(); }
  for (const addresses of [["127.0.0.1"], ["93.184.216.34", "10.0.0.1"], ["::ffff:169.254.169.254"], []]) {
    const before = tunnels.length;
    const unpinned = createEgressProxy(proxyUrl, async () => addresses, undefined, false);
    try {
      await assert.rejects(fetch("http://image.invalid/photo", { dispatcher: unpinned }));
      assert.equal(tunnels.length, before);
    } finally { await unpinned.close(); }
  }
});

test("a DNS upstream the proxy cannot reach falls back to the next one", async () => {
  const resolve = createEgressResolver(local(router), [local(unreachable, "/dns-query"), local(publicDns, "/resolve")]);
  assert.deepEqual(await resolve("feed.invalid"), ["93.184.216.34"]);
});

test("an internal answer is refused at once, not asked again of the next upstream", async () => {
  const resolve = createEgressResolver(local(router), [local(internalDns, "/dns-query"), local(publicDns, "/resolve")]);
  await assert.rejects(resolve("rebind.invalid"), /Blocked proxy address/);
  assert.equal(asked.get("93.184.216.34 rebind.invalid"), undefined);
});

test("an internal answer still ends the lookup when the upstream's other query fails", async () => {
  const resolve = createEgressResolver(local(router), [local(halfInternalDns, "/dns-query"), local(publicDns, "/resolve")]);
  await assert.rejects(resolve("half.invalid"), /Blocked proxy address/);
  assert.equal(asked.get("93.184.216.34 half.invalid"), undefined);
});
