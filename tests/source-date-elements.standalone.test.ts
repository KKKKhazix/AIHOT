// Real listing date labels can carry a Unix debugging tooltip, while detail rules can select a
// metadata element. Neither should hide the date the configured element actually supplies.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchDetail, fromHtml } from "@aihot/backend/sources/web-list";

const html = `<html><head><meta name="date" content="2026-09-11T19:58:33Z"></head><body>` +
  `<article><a href="/post">A real article</a><span title="Unix: 1789171113866">Sep 11, 2026</span></article></body></html>`;
const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a listing uses the visible date when its tooltip is not a publication date", () => {
  const items = fromHtml(html, base, { config: { url: base, itemSelector: "article", publishedAtSelector: "span[title^='Unix:']", publishedAtUtcOffset: "+00:00" } } as never);
  assert.equal(items[0]!.publishedAt?.toISOString(), "2026-09-11T00:00:00.000Z");
});

test("a detail date selector reads meta content and an invalid tooltip does not mask visible text", async () => {
  for (const [publishedAtSelector, expected] of [["meta[name='date']", "2026-09-11T19:58:33.000Z"], ["span", "2026-09-11T00:00:00.000Z"]]) {
    const item = await fetchDetail(base + "/post", { config: { detail: { publishedAtSelector, publishedAtAuthoritative: true, publishedAtUtcOffset: "+00:00" } } } as never, { date: true, title: false, summary: false });
    assert.equal(item.publishedAt?.toISOString(), expected);
  }
});
