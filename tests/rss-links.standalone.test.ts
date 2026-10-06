// Atom link bases are inherited from feed to entry to link, starting at the fetched document URL.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";

const entry = (links: string, base = "") => `<entry${base}><id>urn:test:entry</id><title>Research update</title><updated>2026-10-01T00:00:00Z</updated>${links}</entry>`;
const feed = (entries: string, base = "") => `<feed xmlns="http://www.w3.org/2005/Atom"${base}><id>urn:test:feed</id><title>News</title><updated>2026-10-01T00:00:00Z</updated><author><name>Publisher</name></author>${entries}</feed>`;
const pages: Record<string, string> = {
  "/feed-base": feed(entry('<link href="article-1"/>'), ' xml:base="https://publisher.example/news/"'),
  "/entry-base": feed(entry('<link href="article-1"/>', ' xml:base="https://publisher.example/stories/"'), ' xml:base="https://feed.example/"'),
  "/link-base": feed(entry('<link xml:base="https://publisher.example/articles/" href="article-1"/>')),
  "/news/inherited.xml": feed(entry('<link xml:base="../articles/" href="article-1"/>', ' xml:base="stories/"'), ' xml:base="../publisher/"'),
  "/news/feed.xml": feed(entry('<link href="article-1"/>')),
  "/absolute": feed(entry('<link rel="self" href="entry.xml"/><link rel="alternate" href="https://publisher.example/article-1"/>'), ' xml:base="https://feed.example/"'),
  "/fallback": feed(entry('<link rel="related" href="article-1"/>')),
  "/missing": feed(entry("") + entry('<link rel="alternate"/>')),
  "/fragments": feed(entry('<link href="notes#first"/>') + entry('<link href="notes#second"/>'), ' xml:base="https://publisher.example/"'),
};
const server = http.createServer((req, res) => {
  if (req.url === "/old/feed.xml") {
    res.writeHead(302, { location: "/news/feed.xml" });
    return res.end();
  }
  res.setHeader("content-type", "application/atom+xml");
  res.end(pages[req.url!] ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function read(path: string) {
  return (await fetchRss({ config: { feedUrl: root + path }, participation_mode: "editorial" } as never)).candidates;
}

test("Atom article links honor absolute xml:base on feed, entry and link", async () => {
  for (const [path, expected] of [
    ["/feed-base", "https://publisher.example/news/article-1"],
    ["/entry-base", "https://publisher.example/stories/article-1"],
    ["/link-base", "https://publisher.example/articles/article-1"],
  ]) assert.equal((await read(path!))[0]!.url, expected);
});

test("relative xml:base values compose through feed, entry and link", async () => {
  assert.equal((await read("/news/inherited.xml"))[0]!.url, root + "/publisher/articles/article-1");
});

test("relative Atom links use the final document URL after redirects", async () => {
  assert.equal((await read("/old/feed.xml"))[0]!.url, root + "/news/article-1");
});

test("absolute alternate links and the first-link fallback keep working", async () => {
  assert.equal((await read("/absolute"))[0]!.url, "https://publisher.example/article-1");
  assert.equal((await read("/fallback"))[0]!.url, root + "/article-1");
  assert.deepEqual(await read("/missing"), []);
});

test("resolved Atom article URLs keep their fragments, which sources of page sections use as identity", async () => {
  const items = await read("/fragments");
  assert.deepEqual(items.map((item) => item.url), ["https://publisher.example/notes#first", "https://publisher.example/notes#second"]);
});
