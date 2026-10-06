// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
let origin: string;
let deadline: number;
/** Root metadata answers only after the selected deadline has passed: a slow sibling loader. */
let metaAfterDeadline = false;
const apiCookies: Array<string | undefined> = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiCookies.push(req.headers.cookie);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") {
    const respond = () => res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
    return metaAfterDeadline ? setTimeout(respond, deadline * 1000 - Date.now() + 50) : respond();
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return res.end(JSON.stringify({ filters, cards: [], nextCursor: null, dayCounts: [], hot: null }));
  }
  if (url.pathname === "/api/site/hot") return res.end(JSON.stringify({ entries: [] }));
  if (url.pathname === "/api/site/echo-client") return res.end(JSON.stringify({ forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] }));
  if (url.pathname === "/api/site/download") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="article.md"');
    return res.end("# Article");
  }
  if (url.pathname === "/api/site/items/long-lived") return res.end(JSON.stringify({ id: "long-lived", title: "t" }));
  if (url.pathname === "/api/site/contact") return res.end(JSON.stringify({ wechatQr: "/qr.png", feishuQr: "/qr.png" }));
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return res.end(JSON.stringify({ mergedInto: "surviving-story" }));
  }
  res.statusCode = url.pathname.startsWith("/api/admin/") ? 401 : 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  web = await startWebServer(api);
  origin = web.origin;
});
after(() => web.stop());

test("public route subsets produce the same complete navigation data; filters still differ", async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.ok(body.includes(category));
  assert.notEqual(body, answers[0]);
});

test("navigation streams are plain text for download managers, including errors", async () => {
  for (const [pathname, status] of [["/_.data?_routes=root", 200], ["/items/missing.data", 404]] as const) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, status, pathname);
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8", pathname);
    assert.equal(res.headers.get("Content-Disposition"), null, pathname);
    assert.ok((await res.text()).length > 0, pathname);
  }
  const download = await fetch(origin + "/api/site/download");
  assert.equal(download.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="article.md"');
  assert.equal(await download.text(), "# Article");
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  const plain = await fetch(`${origin}/about.data`);
  const signedIn = await fetch(`${origin}/about.data?_routes=root`, { headers: { cookie: "admin_session=private; reader=returning" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.match(plain.headers.get("X-Accel-Expires")!, /^@\d+$/);
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
  assert.equal(admin.status, 202);
  assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
  assert.equal(admin.headers.get("X-Accel-Expires"), "0");
  assert.match(await admin.text(), /api\/auth\/login/);
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL (at least a whole second), but root metadata
    // finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    metaAfterDeadline = true;
    await Promise.all(["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }));
  } finally {
    deadline = savedDeadline;
    metaAfterDeadline = false;
  }
});

test("a shared cache may keep an item page longer than browsers", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  const cc = res.headers.get("Cache-Control")!;
  assert.equal(Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]), 300);
  assert.ok(Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]) > 300);
  await res.text();
});

// A tab opened before a page lost its loader still asks for that page's result, and its router rejects
// a missing one before React's release recovery can run.
test("a page without a loader still answers navigation with an empty result", async () => {
  const res = await fetch(`${origin}/terms.data?_routes=routes%2Fterms`);
  assert.equal(res.status, 200);
  const { value } = await UNSAFE_decodeViaTurboStream(res.body!, globalThis);
  const result = value as Record<string, { data: unknown }>;
  assert.ok("routes/terms" in result, "an already open router must be able to unwrap its requested route");
  assert.equal(result["routes/terms"]!.data, null);
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});
