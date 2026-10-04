// Reproduce short network failures and YouTube's intermittent missing feed without live services or a database.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { fetchListing } from "@aihot/backend/sources/listing-fetch";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const previousDispatcher = getGlobalDispatcher();
const previousPrivate = config.allowPrivateNetworkFetch;
const previousProxy = config.egressProxyUrl;
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivate;
  config.egressProxyUrl = previousProxy;
  setGlobalDispatcher(previousDispatcher);
  await mock.close();
});

const origin = "https://publisher.invalid";
const channelPath = "/feeds/videos.xml?channel_id=UCV03SRZXJEz-hchIAogeJOg";
const youtube = "https://www.youtube.com";
const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A new video</title><link href="https://www.youtube.com/watch?v=video"/><published>2026-10-02T19:44:06Z</published></entry></feed>';
const source = (kind: string, config: Record<string, unknown>, cursor: SourceRow["cursor"] = null) =>
  ({ id: "listing-retry", kind, config, cursor, participation_mode: "editorial" }) as SourceRow;

test("RSS, HTML and JSON listings recover from a dropped connection and still parse the real items", async () => {
  for (const [kind, path, body] of [
    ["rss", "/rss.xml", xml],
    ["web_list", "/blog", '<a href="/blog/post"><h3>A new post</h3><p>October 02, 2026</p></a>'],
    ["json_list", "/items", JSON.stringify([{ title: "A new post", url: origin + "/post" }])],
  ] as const) {
    const failure = Object.assign(new Error("Client network socket disconnected before secure TLS connection was established"), { code: "ECONNRESET" });
    mock.get(origin).intercept({ path }).replyWithError(failure);
    mock.get(origin).intercept({ path }).reply(200, body);
    const items = kind === "rss" ? (await fetchRss(source(kind, { feedUrl: origin + path }))).candidates
      : kind === "web_list" ? await fetchWebList(source(kind, { url: origin + path, parseMode: "html", itemSelector: "a:has(h3)", titleSelector: "h3", publishedAtSelector: "p", publishedAtUtcOffset: "+00:00" }))
      : await fetchJsonList(source(kind, { url: origin + path, titlePaths: ["title"], urlTemplate: "{raw:url}" }));
    assert.equal(items.length, 1, kind);
    assert.match(items[0]!.title, /^A new /);
  }
});

test("YouTube's intermittent 404 is retried with the same validators and accepts a valid 304", async () => {
  const s = source("rss", { feedUrl: youtube + channelPath });
  mock.get(youtube).intercept({ path: channelPath }).reply(200, xml, { headers: { etag: '"saved"' } });
  const first = await fetchRss(s);
  assert.equal(first.candidates.length, 1);
  s.cursor = { rss: first.validator };
  for (const status of [404, 304]) {
    mock.get(youtube).intercept({ path: channelPath, headers: { "if-none-match": '"saved"' } }).reply(status, "");
  }
  const second = await fetchRss(s);
  assert.equal(second.notModified, true);
  assert.deepEqual(second.candidates, []);
  assert.equal(second.validator.etag, '"saved"');
});

test("a persistently missing YouTube feed still fails after exactly two reads", async () => {
  const path = "/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa";
  let hits = 0;
  mock.get(youtube).intercept({ path }).reply(404, () => { hits++; return "Missing"; }).persist();
  await assert.rejects(fetchRss(source("rss", { feedUrl: youtube + path })), /HTTP 404/);
  assert.equal(hits, 2);
});

test("a second dropped connection fails rather than reading a third time", async () => {
  const path = "/twice";
  const failure = Object.assign(new Error("Socket closed"), { code: "ECONNRESET" });
  mock.get(origin).intercept({ path }).replyWithError(failure).times(2);
  mock.get(origin).intercept({ path }).reply(200, "Must not be read");
  await assert.rejects(fetchListing(origin + path), (error: Error) => (error.cause as NodeJS.ErrnoException)?.code === failure.code);
  assert.equal(mock.pendingInterceptors().filter(i => i.path === path).length, 1);
});

test("the retry shares the first read's deadline instead of getting another full timeout", async () => {
  const path = "/shared-deadline";
  mock.get(origin).intercept({ path }).reply(500, "Temporary error");
  mock.get(origin).intercept({ path }).reply(200, "Too late").delay(1200);
  await assert.rejects(fetchListing(origin + path, { timeoutMs: 1800 }), { name: "TimeoutError" });
});

test("upstream 500 is retried once, but ordinary missing URLs and access/rate refusals are read once", async () => {
  mock.get(origin).intercept({ path: "/temporary" }).reply(500, "Temporary error");
  mock.get(origin).intercept({ path: "/temporary" }).reply(200, "Recovered");
  assert.equal((await fetchListing(origin + "/temporary")).text(), "Recovered");
  for (const [host, path, status] of [
    [origin, "/missing", 404], [origin, "/auth", 401], [origin, "/verify", 403], [origin, "/rate", 429],
    ["https://www.youtube.com.evil.invalid", channelPath, 404], [youtube, "/watch?v=missing", 404],
  ] as const) {
    let hits = 0;
    mock.get(host).intercept({ path }).reply(status, () => { hits++; return "Refused"; }).persist();
    assert.equal((await fetchListing(host + path)).status, status);
    assert.equal(hits, 1, host + path);
  }
});

test("POST listings, paid callers and an exhausted retry budget do not gain another request", async () => {
  let posts = 0;
  mock.get(origin).intercept({ path: "/post", method: "POST" }).reply(500, () => { posts++; return "Error"; }).persist();
  await assert.rejects(fetchJsonList(source("json_list", { url: origin + "/post", method: "POST", bodyJson: { query: "items" } })), /HTTP 500/);
  assert.equal(posts, 1);
  for (const path of ["/paid", "/deadline"]) {
    let hits = 0;
    mock.get(origin).intercept({ path }).reply(500, () => { hits++; return "Error"; }).persist();
    const response = path === "/paid" ? await guardedFetch(origin + path) : await fetchListing(origin + path, { timeoutMs: 500 });
    assert.equal(response.status, 500);
    assert.equal(hits, 1, path);
  }
});

test("security and parsing failures are not retried or turned into empty successes", async () => {
  const failure = Object.assign(new Error("Certificate expired"), { code: "CERT_HAS_EXPIRED" });
  mock.get(origin).intercept({ path: "/certificate" }).replyWithError(failure);
  await assert.rejects(fetchListing(origin + "/certificate"), (error: Error) => (error.cause as Error)?.message === failure.message);
  let hits = 0;
  mock.get(origin).intercept({ path: "/bad.xml" }).reply(200, () => { hits++; return "<not-feed/>"; }).persist();
  await assert.rejects(fetchRss(source("rss", { feedUrl: origin + "/bad.xml" })), /not an RSS/);
  assert.equal(hits, 1);
  config.allowPrivateNetworkFetch = false;
  try { await assert.rejects(fetchListing("http://127.0.0.1/metadata"), /Blocked/); }
  finally { config.allowPrivateNetworkFetch = true; }
});
