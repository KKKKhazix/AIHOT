// Failures found in source audits: product/version labels parsed as dates, rolled-over calendar
// dates, and dated help-center sections collected as a single article or without their full body.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { contentHash } from "@aihot/backend/content/materials";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { parseLooseDate } from "@aihot/backend/sources/dates";

const section = (id: string, date: string, title: string, body: string) =>
  `<div class="intercom-interblocks-subheading3"><h3 id="${id}">${date}</h3></div>` +
  `<div class="intercom-interblocks-paragraph"><p><b>${title}</b></p></div>` +
  `<div class="intercom-interblocks-paragraph"><p>${body}</p></div>`;
const older = section("h_older", "September 25, 2026", "Build plugins", "Create a plugin and track its review.");
const newest = section("h_newest", "September 28, 2026", "A model launch", 'A new model is available. <a href="/docs/new">Read about it</a>.');
let prepend = false;
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/help/notes" });
    res.end();
    return;
  }
  res.end(`<html><body><h1>Release notes</h1><article>` +
    `<div class="intercom-interblocks-subheading"><h2 id="h_month">September 2026</h2></div>` +
    (prepend ? section("h_future", "October 1, 2026", "Another release", "A separate update.") : "") + newest + older +
    `<div class="intercom-interblocks-subheading3"><h3 id="h_empty">September 20, 2026</h3></div>` +
    `<div><p> </p></div><div class="intercom-interblocks-subheading"><h2 id="h_old_month">August 2026</h2></div>` +
    `</article><footer>Help center footer</footer></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const source = { config: { url: base + "/redirect", parseMode: "intercom_changelog", publishedAtUtcOffset: "+00:00" } } as never;

test("dates require a real complete calendar day, never a product version or an impossible day", () => {
  for (const value of ["Version 3", "Sonnet 5", "5", "September 2026", "2026-02-30", "2026/02/30 12:00", "2026年4月31日", "February 30, 2026"]) {
    assert.equal(parseLooseDate(value), null, value);
  }
  assert.equal(parseLooseDate("February 29, 2024", "+00:00")?.toISOString(), "2024-02-29T00:00:00.000Z");
});

test("Intercom daily sections have independent URLs, dates and complete bodies without month headings or empty days", async () => {
  assert.deepEqual(unsupportedConfig("web_list", (source as { config: Record<string, unknown> }).config), []);
  const items = await fetchWebList(source);
  assert.deepEqual(items.map((item) => [item.url, item.title, item.publishedAt?.toISOString(), item.bodyStatus]), [
    [base + "/help/notes#h_newest", "A model launch", "2026-09-28T00:00:00.000Z", "ok"],
    [base + "/help/notes#h_older", "Build plugins", "2026-09-25T00:00:00.000Z", "ok"],
  ]);
  assert.notEqual(items[0]!.identityKey, items[1]!.identityKey);
  assert.match(items[0]!.bodyHtml!, new RegExp(`href="${base}/docs/new"`));
  assert.doesNotMatch(items[0]!.bodyText!, /Build plugins|Help center footer/);
});

test("inserting a new help-center section does not change older identities or material hashes", async () => {
  const before = await fetchWebList(source);
  prepend = true;
  const after = await fetchWebList(source);
  for (const item of before) {
    const same = after.find((candidate) => candidate.identityKey === item.identityKey);
    assert.ok(same);
    assert.equal(contentHash(same), contentHash(item));
  }
});
