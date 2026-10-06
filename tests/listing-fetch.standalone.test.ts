// Free listing reads: one retry after a dropped connection or an upstream 500, YouTube's intermittent
// missing feed included, and nothing else is read twice. Without live services or a database.
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { after, mock, test } from "node:test";
import timersPromises from "node:timers/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { fetchListing } from "@aihot/backend/sources/listing-fetch";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const previousDispatcher = getGlobalDispatcher();
const previousPrivate = config.allowPrivateNetworkFetch;
const previousProxy = config.egressProxyUrl;
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
// The pause before the retry is not what is under test.
mock.method(timersPromises, "setTimeout", async () => undefined);
syncBuiltinESMExports();
after(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  config.allowPrivateNetworkFetch = previousPrivate;
  config.egressProxyUrl = previousProxy;
  setGlobalDispatcher(previousDispatcher);
  await mockAgent.close();
});

const origin = "https://publisher.invalid";
const channelPath = "/feeds/videos.xml?channel_id=UCV03SRZXJEz-hchIAogeJOg";
const youtube = "https://www.youtube.com";
const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A new video</title><link href="https://www.youtube.com/watch?v=video"/><published>2026-10-02T19:44:06Z</published></entry></feed>';
const source = (kind: string, config: Record<string, unknown>, cursor: SourceRow["cursor"] = null) =>
  ({ id: "listing-retry", kind, config, cursor, participation_mode: "editorial" }) as SourceRow;
const dropped = (message = "Client network socket disconnected before secure TLS connection was established") =>
  Object.assign(new Error(message), { code: "ECONNRESET" });

test("RSS, HTML and JSON listings recover from a dropped connection, a second drop fails", async () => {
  for (const [kind, path, body] of [
    ["rss", "/rss.xml", xml],
    ["web_list", "/blog", '<a href="/blog/post"><h3>A new post</h3><p>October 02, 2026</p></a>'],
    ["json_list", "/items", JSON.stringify([{ title: "A new post", url: origin + "/post" }])],
  ] as const) {
    mockAgent.get(origin).intercept({ path }).replyWithError(dropped());
    mockAgent.get(origin).intercept({ path }).reply(200, body);
    const items = kind === "rss" ? (await fetchRss(source(kind, { feedUrl: origin + path }))).candidates
      : kind === "web_list" ? await fetchWebList(source(kind, { url: origin + path, parseMode: "html", itemSelector: "a:has(h3)", titleSelector: "h3", publishedAtSelector: "p", publishedAtUtcOffset: "+00:00" }))
      : await fetchJsonList(source(kind, { url: origin + path, titlePaths: ["title"], urlTemplate: "{raw:url}" }));
    assert.equal(items.length, 1, kind);
    assert.match(items[0]!.title, /^A new /);
  }
  const failure = dropped("Socket closed");
  mockAgent.get(origin).intercept({ path: "/twice" }).replyWithError(failure).times(2);
  mockAgent.get(origin).intercept({ path: "/twice" }).reply(200, "Must not be read");
  await assert.rejects(fetchListing(origin + "/twice"), (error: Error) => (error.cause as NodeJS.ErrnoException)?.code === failure.code);
  assert.equal(mockAgent.pendingInterceptors().filter(i => i.path === "/twice").length, 1);
});

test("YouTube's intermittent 404 is retried with the same validators and accepts a valid 304", async () => {
  const s = source("rss", { feedUrl: youtube + channelPath });
  mockAgent.get(youtube).intercept({ path: channelPath }).reply(200, xml, { headers: { etag: '"saved"' } });
  const first = await fetchRss(s);
  assert.equal(first.candidates.length, 1);
  s.cursor = { rss: first.validator };
  for (const status of [404, 304]) {
    mockAgent.get(youtube).intercept({ path: channelPath, headers: { "if-none-match": '"saved"' } }).reply(status, "");
  }
  const second = await fetchRss(s);
  assert.equal(second.notModified, true);
  assert.deepEqual(second.candidates, []);
  assert.equal(second.validator.etag, '"saved"');
});

test("upstream 500 is retried once, but ordinary missing URLs and access/rate refusals are read once", async () => {
  mockAgent.get(origin).intercept({ path: "/temporary" }).reply(500, "Temporary error");
  mockAgent.get(origin).intercept({ path: "/temporary" }).reply(200, "Recovered");
  assert.equal((await fetchListing(origin + "/temporary")).text(), "Recovered");
  for (const [host, path, status] of [
    [origin, "/missing", 404], [origin, "/auth", 401], [origin, "/verify", 403], [origin, "/rate", 429],
    ["https://www.youtube.com.evil.invalid", channelPath, 404], [youtube, "/watch?v=missing", 404],
  ] as const) {
    let hits = 0;
    mockAgent.get(host).intercept({ path }).reply(status, () => { hits++; return "Refused"; }).persist();
    assert.equal((await fetchListing(host + path)).status, status);
    assert.equal(hits, 1, host + path);
  }
});
