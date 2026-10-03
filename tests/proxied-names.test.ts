// Collection through EGRESS_PROXY_URL: the proxy resolves names and connects abroad, so a poisoned local
// answer (Teredo, documentation, reserved addresses) must not refuse a site the proxy can reach, while an
// answer that reaches this host or its network still does. Address literals keep the full check.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicUrl, isInternalAddress } from "@aihot/backend/lib/url";

test("through the egress proxy only internal answers refuse a name; literals keep the full check", async () => {
  const internal = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:a9fe:a9fe::1"];
  const unroutable = ["2001::58bf:f9b6", "2001:db8::1", "255.255.255.255", "224.0.0.1", "192.0.2.1", "8.8.8.8", "2606:4700:4700::1111"];
  assert.deepEqual(internal.filter((a) => !isInternalAddress(a)), [], "internal not recognised");
  assert.deepEqual(unroutable.filter((a) => isInternalAddress(a)), [], "wrongly internal");
  for (const url of ["http://localhost/", "http://[::ffff:127.0.0.1]/", "http://[2001:db8::1]/", "http://10.0.0.1/"]) {
    await assert.rejects(assertPublicUrl(url, false, true), Error, url);
  }
});
