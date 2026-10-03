// summaryIsBody: a source whose feed summary is the whole item keeps it as the body whatever its length,
// as json_list does; without it a short summary still sends the item to its page first.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";

const description = "How leaders build confidence with their team.";
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/rss+xml");
  res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Show</title><item><title>Episode 42</title>`
    + `<link>https://example.org/episodes/42</link><pubDate>Wed, 01 Oct 2026 00:00:00 GMT</pubDate><description>${description}</description></item></channel></rss>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const feedUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/feed.xml`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const read = async (extra: Record<string, unknown>) =>
  (await fetchRss({ id: "test-summary-body", config: { feedUrl, ...extra }, participation_mode: "editorial" } as never)).candidates[0]!;

test("a short summary asks for the page unless the source declares it the body", async () => {
  const plain = await read({});
  assert.deepEqual([plain.bodyStatus, plain.bodyText, plain.excerpt], ["pending", null, description]);
  const declared = await read({ summaryIsBody: true });
  assert.deepEqual([declared.bodyStatus, declared.bodyText, declared.excerpt], ["ok", description, description]);
});
