// Failure cases: tracking aliases miss the stored article, duplicate cards buy duplicate detail
// requests, fragment-aware HTML lists collapse separate updates, a podcast episode linked to its media
// file changes identity or sends the file to page extraction.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { identityKeyFor } from "@aihot/backend/content/materials";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

let detailHits = 0;
let campaign = "first";
const server = http.createServer((req, res) => {
  const path = req.url!;
  if (path === "/podcast.xml") {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(`<rss version="2.0"><channel><title>Show</title>${Object.entries(EPISODES).map(([n, tags]) =>
      `<item><title>Episode ${n}</title>${tags}<pubDate>${new Date().toUTCString()}</pubDate></item>`).join("")}</channel></rss>`);
  } else if (path.startsWith("/post")) {
    detailHits++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><head><title>Detail</title></head><body><h1>Actual headline</h1></body></html>');
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(path === "/sections.md" ? `[First update](${base}/sections.md#one)\n[Second update](${base}/sections.md#two)` :
      path === "/sections" ? '<a href="#one">First update</a><a href="#two">Second update</a>' :
      Array.from({ length: 10 }, (_, i) => `<a href="/post?utm_source=${campaign}${i}">Read more</a>`).join(""));
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const audio = (n: number) => `<enclosure url="${base}/episodes/${n}.mp3" type="audio/mpeg" length="1"/>`;
// No page (a guid that is no address), a page link, an address guid, and neither page nor media file.
const EPISODES: Record<number, string> = {
  1: `<guid isPermaLink="false">Buzzsprout-1</guid>${audio(1)}`,
  2: `<link>https://example.org/episodes/2</link><guid isPermaLink="false">Buzzsprout-2</guid>${audio(2)}`,
  3: `<guid>https://example.org/episodes/3</guid>${audio(3)}`,
  4: `<guid isPermaLink="false">Buzzsprout-4</guid>`,
};
config.allowPrivateNetworkFetch = true;
after(async () => { server.close(); await stopBoss(); await closeDb(); });
async function source(kind: string, settings: Record<string, unknown>) {
  const id = `identity-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,config,cursor) VALUES (${id},'Identity test',${kind},${sql.json(settings as never)},${sql.json({ initializedAt: new Date().toISOString() })})`;
  return id;
}

test("detail enrichment shares material identity across duplicate cards and changing tracking parameters", async () => {
  const id = await source("web_list", { url: `${base}/listing`, detail: { titleSelector: "h1", maxFetches: 10 } });
  assert.equal((await collectSource(id)).created, 1);
  const firstHits = detailHits;
  campaign = "second";
  const result = await collectSource(id);
  assert.equal(firstHits, 1, "one article needs only one detail request even when ten cards link to it");
  assert.equal(result.status, "ok");
  assert.equal(result.revised, 0);
  assert.equal(detailHits, 1, "stored identity reuses the confirmed title without another detail request");
  const [row] = await sql`SELECT title,revision FROM articles WHERE source_id=${id}`;
  assert.deepEqual({ ...row }, { title: "Actual headline", revision: 1 });
});

for (const parseMode of ["html", "markdown"]) test(`${parseMode} sections explicitly configured as posts retain distinct identities`, async () => {
  const id = await source("web_list", { url: `${base}/sections${parseMode === "markdown" ? ".md" : ""}`, parseMode, preserveUrlFragment: true });
  assert.equal((await collectSource(id)).created, 2);
  assert.equal((await collectSource(id)).revised, 0);
  const rows = await sql`SELECT url,revision FROM articles WHERE source_id=${id} ORDER BY url`;
  assert.deepEqual(rows.map(r => [String(r.url).split("#")[1], r.revision]), [["one", 1], ["two", 1]]);
});

test("a podcast episode without a page links to its media file, keeps its guid's identity and is not sent to fetch a page", async () => {
  const id = await source("rss", { feedUrl: `${base}/podcast.xml` });
  assert.equal((await collectSource(id)).created, 4);
  const rows = await sql`SELECT a.identity_key,a.url,a.title,a.body_status,j.name AS job FROM articles a
    LEFT JOIN pgboss.job j ON j.data->>'articleId'=a.id WHERE a.source_id=${id} ORDER BY a.title`;
  assert.deepEqual(rows.map(r => r.url), [`${base}/episodes/1.mp3`, "https://example.org/episodes/2", "https://example.org/episodes/3", "Buzzsprout-4"],
    "a page link or an address guid still wins; without page or media file the guid stays");
  const [episode] = rows;
  assert.equal(episode!.identity_key, identityKeyFor({ sourceId: id, url: "Buzzsprout-1", title: "Episode 1", via: "fetch" }), "the identity an episode stored under its guid had");
  assert.deepEqual([episode!.body_status, episode!.job], ["none", QUEUES.analyze], "judged on the feed: the media file is no page to extract");
  assert.equal((await collectSource(id)).created, 0);
});
