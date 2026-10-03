// Failure cases: a blocked local DNS holds every image in the lookup thread pool; a proxy resolves
// a checked name to an internal address; CONNECT loses the original HTTP host or IPv6 authority.
// Exercise real HTTP CONNECT requests against a local proxy before fixing.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { createEgressProxy } from "@aihot/backend/lib/egress-proxy";

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

test("egress resolves independently of local DNS and pins CONNECT while preserving Host", async () => {
  const agent = createEgressProxy(proxyUrl, async () => ["93.184.216.34"]);
  try {
    const res = await fetch("http://image.invalid:8080/photo", { dispatcher: agent });
    assert.equal(await res.text(), "image.invalid:8080");
    assert.equal(tunnels.at(-1), "93.184.216.34:8080");
  } finally { await agent.close(); }
});

test("internal, mixed, reserved, empty and malformed DNS answers never reach the proxy", async () => {
  for (const addresses of [["127.0.0.1"], ["93.184.216.34", "10.0.0.1"], ["::ffff:169.254.169.254"], ["2001:db8::1"], [], ["not-an-ip"]]) {
    const before = tunnels.length;
    const agent = createEgressProxy(proxyUrl, async () => addresses);
    try {
      await assert.rejects(fetch("http://image.invalid/photo", { dispatcher: agent }));
      assert.equal(tunnels.length, before);
    } finally { await agent.close(); }
  }
});

test("IPv6-only public destinations keep a bracketed CONNECT authority", async () => {
  const agent = createEgressProxy(proxyUrl, async () => ["2606:4700:4700::1111"]);
  try {
    const res = await fetch("http://image.invalid/photo", { dispatcher: agent });
    assert.equal(await res.text(), "image.invalid");
    assert.equal(tunnels.at(-1), "[2606:4700:4700::1111]:80");
  } finally { await agent.close(); }
});
