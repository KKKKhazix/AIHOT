// Observed failures: Atom video descriptions were discarded, then player controls and recommended
// videos were saved as article bodies. Known video pages must never buy article extraction; a feed
// description is only an excerpt, while actual textual content delivered by the feed remains usable.
import "./setup.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { extractFromUrl, pageFetchable, readable } from "@aihot/backend/content/extract";
import { fetchRss } from "@aihot/backend/sources/rss";

const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = createRequire(new URL("../packages/backend/package.json", import.meta.url))("undici");
const originalDispatcher = getGlobalDispatcher();
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
const previousPrivateFetch = config.allowPrivateNetworkFetch;
const previousProxy = config.egressProxyUrl;
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  config.egressProxyUrl = previousProxy;
  setGlobalDispatcher(originalDispatcher);
  await mock.close();
});

const watch = "https://www.youtube.com/watch?v=COJAZQM1aeQ";
const shorts = "https://www.youtube.com/shorts/FByNauagcbY";
const videoUrls = [watch, shorts, "https://m.youtube.com/watch?v=COJAZQM1aeQ", "https://youtu.be/COJAZQM1aeQ", "https://www.youtube.com/embed/COJAZQM1aeQ", "https://vimeo.com/1105244173", "https://player.vimeo.com/video/1105244173"];
const playerText = "Back Skip navigation Search Search with your voice Sign in Video Build an App With Claude Design Tap to unmute Watch later Share Copy link Info Shopping If playback does not begin shortly, try restarting your device. Video unavailable. You are signed out. Videos you watch may be added to the TV watch history and influence TV recommendations. Cancel Confirm. I Tried The LAZIEST Way to Make Money With AI. ";
const playerHtml = `<html><head><title>Watch video</title></head><body><article><p>${playerText.repeat(3)}</p></article></body></html>`;
const feedBody = "The publisher supplied an actual explanatory text alongside this video. ".repeat(8);
const entry = (url: string, fields = "") => `<entry><id>entry:${url}</id><title>A video update</title><published>2026-10-03T00:00:00Z</published><link href="${url.replaceAll("&", "&amp;")}"/>${fields}</entry>`;
const atom = (entries: string) => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">${entries}</feed>`;
const fixtures: Record<string, string> = {
  "/media.xml": atom(entry(watch, `<media:group><media:content url="https://www.youtube.com/v/COJAZQM1aeQ" type="application/x-shockwave-flash"/><media:description>Use &lt;video&gt; and a real app. This is a video description, not a transcript.</media:description></media:group>`) + entry(shorts, `<media:description type="html">&lt;p&gt;A &lt;b&gt;short video&lt;/b&gt; description.&lt;/p&gt;</media:description>`)),
  "/rss.xml": `<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title>Video</title><link>https://vimeo.com/1105244173</link><media:group><media:content medium="video" type="video/mp4"/><media:description>Published video description.</media:description></media:group></item></channel></rss>`,
  "/content.xml": atom(entry(watch, `<content type="html"><![CDATA[<p>${feedBody}</p>]]></content>`)),
  "/summary.xml": atom(entry(watch, `<summary>${feedBody}</summary>`)),
  "/text.xml": atom(entry("https://publisher.example/article", `<summary>${feedBody}</summary>`)),
  "/article-with-video.xml": atom(entry("https://publisher.example/article", `<media:group><media:content medium="video"/><media:description>An accompanying clip.</media:description></media:group>`)),
};
for (const [path, xml] of Object.entries(fixtures)) mock.get("https://publisher.example").intercept({ path }).reply(200, xml, { headers: { "content-type": "application/atom+xml" } }).persist();
let videoReads = 0;
for (const origin of ["https://www.youtube.com", "https://m.youtube.com", "https://youtu.be", "https://vimeo.com", "https://player.vimeo.com"]) {
  mock.get(origin).intercept({ path: /.*/ }).reply(() => { videoReads++; return { statusCode: 200, data: playerHtml, responseOptions: { headers: { "content-type": "text/html" } } }; }).persist();
}
mock.get("https://publisher.example").intercept({ path: "/video-link" }).reply(302, "", { headers: { location: watch } });

const read = async (path: string, summaryIsBody = false) => (await fetchRss({ id: "video-fixture", kind: "rss", participation_mode: "editorial", config: { feedUrl: "https://publisher.example" + path, summaryIsBody } } as never)).candidates;

test("Atom and RSS Media descriptions survive as excerpts without pretending to be video body text", async () => {
  const items = await read("/media.xml");
  assert.deepEqual(items.map(item => [item.excerpt, item.bodyStatus, item.bodyText]), [
    ["Use <video> and a real app. This is a video description, not a transcript.", "none", null],
    ["A short video description.", "none", null],
  ]);
  const [rss] = await read("/rss.xml");
  assert.equal(rss!.excerpt, "Published video description.");
  assert.equal(rss!.bodyStatus, "none");
});

test("actual textual feed content stays usable, while a video summary never becomes a transcript", async () => {
  const [content] = await read("/content.xml");
  assert.equal(content!.bodyStatus, "ok");
  assert.equal(content!.bodyText, feedBody.trim());
  const [summary] = await read("/summary.xml", true);
  assert.equal(summary!.bodyStatus, "none");
  assert.equal(summary!.bodyText, null);
  assert.equal(summary!.excerpt, feedBody.trim());
  assert.equal((await read("/text.xml", true))[0]!.bodyStatus, "ok", "ordinary textual sources keep their explicit summary-is-body policy");
  assert.equal((await read("/article-with-video.xml"))[0]!.bodyStatus, "pending", "an article can have an accompanying video and still need its article body");
});

test("known video pages cannot pass the generic body reader or page-fetch policy", () => {
  for (const url of videoUrls) {
    assert.equal(pageFetchable(url, "rss"), false, url);
    assert.equal(readable(playerHtml, url), null, url);
  }
  for (const url of ["https://publisher.example/watch?v=article", "https://blog.youtube/news-and-events/article", "https://vimeo.com/blog/post", "https://youtube.com.example/article"]) assert.equal(pageFetchable(url, "rss"), true, url);
  assert.ok(readable(`<html><body><article><p>${feedBody}</p><iframe src="${watch}"></iframe></article></body></html>`, "https://publisher.example/article"));
});

test("manual extraction makes no video request, and an ordinary link redirected to a player cannot save its controls", async () => {
  for (const url of videoUrls) assert.equal(await extractFromUrl(url, "test-video"), null, url);
  assert.equal(videoReads, 0, "video pages are rejected before a network request or paid fallback");
  assert.equal(await extractFromUrl("https://publisher.example/video-link", "test-redirect"), null);
});
