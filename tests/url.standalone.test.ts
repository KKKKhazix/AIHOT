// The fetch guard: internal addresses stay unreachable in every spelling, and a name that resolves
// to one is refused at connect time too (DNS rebinding after the URL check).
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { after, mock, test } from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { assertPublicUrl, guardedLookup, isBlockedAddress } from "@aihot/backend/lib/url";

let hits = 0;
const server = http.createServer((_req, res) => { hits++; res.end("public content"); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const { port } = server.address() as { port: number };
after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("internal and reserved addresses are blocked in every spelling", () => {
  const blocked = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255",
    "198.18.0.0", "198.18.0.1", "198.19.255.255", "::ffff:198.18.0.1", "64:ff9b::c612:1", "2002:c612:1::1",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "::7f00:1", // IPv4-mapped and -compatible
    "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2001:0:4136:e378::1", // NAT64, 6to4, Teredo
    "not-an-ip",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"];
  assert.deepEqual(blocked.filter((a) => !isBlockedAddress(a)), [], "not blocked");
  assert.deepEqual(allowed.filter((a) => isBlockedAddress(a)), [], "wrongly blocked");
});

test("URL literals that embed a loopback address are refused before any request", async () => {
  for (const url of ["http://[::ffff:127.0.0.1]/", "http://[::127.0.0.1]/", "http://[64:ff9b::127.0.0.1]/", "http://localhost/"]) {
    await assert.rejects(assertPublicUrl(url), Error, url);
  }
  await assert.rejects(guardedFetch(`http://[::ffff:127.0.0.1]:${port}/`));
});

// Benchmark space is not public address space. Local proxy fake-IP routing must not make it a
// production exception; URL parsing also turns decimal/hex literals into the same destination.
test("benchmark literals are refused without a local-debug override", async () => {
  for (const host of ["198.18.0.1", "198.19.255.255", "3323068417", "0xc6120001", "[::ffff:198.18.0.1]"]) {
    await assert.rejects(assertPublicUrl(`http://${host}/`), /Blocked/, host);
  }
  assert.equal((await assertPublicUrl("http://198.18.0.1/", true)).hostname, "198.18.0.1");
});

test("the connection guard refuses private, mixed, reserved and empty DNS answers, including a changed answer", async () => {
  const agent = new Agent({ connect: { lookup: guardedLookup as never } });
  const before = hits;
  const answers: Record<string, string[]> = { "public.invalid": ["93.184.216.34"], "private.invalid": ["127.0.0.1"],
    "mixed.invalid": ["93.184.216.34", "127.0.0.1"], "reserved.invalid": ["198.18.0.1"], "empty.invalid": [] };
  const savedLookup = dns.lookup;
  mock.method(dns, "lookup", async (host: string, options: unknown) => {
    if (!(host in answers)) return savedLookup(host, options as never);
    return answers[host]!.map(address => ({ address, family: 4 }));
  });
  const savedConnect = net.connect;
  mock.method(net, "connect", function (this: unknown, options: net.TcpNetConnectOpts, ...rest: unknown[]) {
    if (options.host && options.host in answers) {
      const lookup = options.lookup!;
      // Only an address already accepted by the real guard reaches the local fixture.
      options = { ...options, port, lookup(host, opts, done) {
        lookup(host, opts, (error, address, family) => {
          if (error) return done(error, address, family);
          done(null, Array.isArray(address) ? address.map(a => ({ ...a, address: "127.0.0.1" })) : "127.0.0.1", family);
        });
      } };
    }
    return Reflect.apply(savedConnect, this, [options, ...rest]);
  });
  syncBuiltinESMExports();
  try {
    const read = async (host: string, targetPort = port) => {
      const response = await undiciFetch(`http://${host}:${targetPort}/`, { dispatcher: agent });
      return response.text();
    };
    assert.equal(await read("public.invalid"), "public content");
    for (const host of ["private.invalid", "mixed.invalid", "reserved.invalid", "empty.invalid"]) {
      await assert.rejects(read(host));
    }
    answers["public.invalid"] = ["127.0.0.1"];
    await assert.rejects(read("public.invalid", port + 1), "a new connection cannot reuse the name's previous public DNS answer");
    assert.equal(hits, before + 1, "refused DNS answers never reach the destination");
  } finally {
    await agent.destroy();
    mock.restoreAll(); syncBuiltinESMExports();
  }
});
