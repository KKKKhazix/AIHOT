// Podcast episodes without <link>: readers get the media file, and the identity stays the one the guid gave.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { identityKeyFor } from "@aihot/backend/content/materials";
import { fetchRss } from "@aihot/backend/sources/rss";

const audio = "https://media.example.org/episodes/42.mp3";
const items: Record<string, string> = {
  "/guid": `<guid isPermaLink="false">Buzzsprout-19886508</guid><enclosure url="${audio}" type="audio/mpeg" length="1"/>`,
  "/page": `<link>https://example.org/episodes/42</link><guid isPermaLink="false">Buzzsprout-19886508</guid><enclosure url="${audio}" type="audio/mpeg" length="1"/>`,
  "/address": `<guid>https://example.org/episodes/42</guid><enclosure url="${audio}" type="audio/mpeg" length="1"/>`,
  "/bare": `<guid isPermaLink="false">Buzzsprout-19886508</guid>`,
};
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/rss+xml");
  res.end(`<rss version="2.0"><channel><title>Show</title><link>https://example.org/</link><item><title>Episode 42: Keeping staff</title>${items[req.url!]}</item></channel></rss>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function read(path: string) {
  const feedUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`;
  const [item] = (await fetchRss({ id: "pod-test", config: { feedUrl }, participation_mode: "editorial" } as never)).candidates;
  return item!;
}

test("an episode without a page links to its media file and keeps the identity its guid gave", async () => {
  const item = await read("/guid");
  assert.equal(item.url, audio);
  const before = identityKeyFor({ sourceId: "pod-test", url: "Buzzsprout-19886508", title: item.title, via: "fetch" });
  assert.equal(item.identityKey, before, "an episode stored under its guid is not collected again");
});

test("a page link or an address guid still wins over the media file", async () => {
  assert.equal((await read("/page")).url, "https://example.org/episodes/42");
  assert.equal((await read("/address")).url, "https://example.org/episodes/42");
  assert.equal((await read("/page")).identityKey, undefined);
});

test("an episode with neither page nor media file is kept as before", async () => {
  const item = await read("/bare");
  assert.equal(item.url, "Buzzsprout-19886508");
  assert.equal(item.identityKey, undefined);
});
