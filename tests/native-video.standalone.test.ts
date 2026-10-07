// Readability retained these videos, but cleaning discarded lazy URLs, source candidates and controls.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { readable } from "@aihot/backend/content/extract";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { bodyToMarkdown, markdownBody } from "@aihot/backend/content/markdown";
import { shield, unshield } from "@aihot/backend/editorial/translate";
import { proxyBodyImages } from "@aihot/backend/media/imgproxy";
import { stripTags } from "@aihot/backend/lib/text";

const base = "https://publisher.example/posts/article";
const prose = "An ordinary article explains the announcement and includes a demonstration of the work. ".repeat(6);
const video = '<video data-src="/clip.mp4?token=example&amp;quality=high" data-poster="/cover.jpg?token=poster&amp;frame=1" width="1280" height="720" autoplay loop controls preload="auto"></video>';

test("article extraction preserves lazy video resources and makes playback manual", () => {
  const body = readable(`<html><head><title>Article</title></head><body><article><h1>Article</h1><p>${prose}</p>${video}<p>${prose}</p></article></body></html>`, base);
  assert.ok(body);
  const $ = cheerio.load(body.html);
  assert.equal($("video").attr("src"), "https://publisher.example/clip.mp4?token=example&quality=high");
  assert.equal($("video").attr("poster"), "https://publisher.example/cover.jpg?token=poster&frame=1");
  assert.equal($("video").attr("width"), "1280");
  assert.equal($("video").attr("height"), "720");
  assert.ok($("video").is("[controls][playsinline]"));
  assert.equal($("video").attr("preload"), "none");
  assert.doesNotMatch(body.html, /data-src|data-poster|autoplay|\bloop=/);
  assert.equal(sanitizeBody(body.html, base), body.html, "translation and export can clean the body again");
  const native = cheerio.load(sanitizeBody('<video src="/native.mp4" data-src="/other.mp4" poster="/native.jpg" data-poster="/other.jpg"></video>', base));
  assert.equal(native("video").attr("src"), "https://publisher.example/native.mp4");
  assert.equal(native("video").attr("poster"), "https://publisher.example/native.jpg");
});

test("video source candidates retain order, types and lazy URLs without opening picture sources", () => {
  const html = sanitizeBody('<picture><source srcset="/image.webp 1x"><img src="/image.png"></picture><source src="/orphan.mp4"><video><source data-src="/clip.webm" type="video/webm"><source src="/clip.mp4" data-src="/other.mp4" type="video/mp4"><source src="javascript:alert(1)"></video>', base);
  const $ = cheerio.load(html);
  assert.deepEqual($("video > source").map((_, el) => [[$(el).attr("src"), $(el).attr("type")]]).get(), [
    ["https://publisher.example/clip.webm", "video/webm"],
    ["https://publisher.example/clip.mp4", "video/mp4"],
  ]);
  assert.equal($("source").length, 2);
  assert.equal($("picture img").attr("src"), "https://publisher.example/image.png");
  assert.ok($("video").is("[controls]"));
  assert.doesNotMatch(html, /srcset|orphan|javascript:/);
});

test("unsafe media cannot survive normalization and empty players keep only safe fallback content", () => {
  const html = sanitizeBody('<p>Before</p><video width="1280" height="720" data-src="javascript:alert(1)" data-poster="javascript:alert(2)" onclick="alert(3)"><source data-src="data:video/mp4;base64,AAAA"><script>alert(4)</script><a href="https://example.org/watch">Watch elsewhere</a></video><video></video><p>After</p>', base);
  const $ = cheerio.load(html);
  assert.equal($("video, source, script").length, 0);
  assert.equal($("a").text(), "Watch elsewhere");
  assert.doesNotMatch(html, /javascript:|data:|onclick|alert\(/);
  const poster = cheerio.load(sanitizeBody('<video poster="/cover.jpg" controls preload="auto"></video>', base));
  assert.equal(poster("video").attr("poster"), "https://publisher.example/cover.jpg");
  assert.equal(poster("video").attr("controls"), undefined);
  for (const [input, expected] of [
    ['<p>before<video></video>after</p>', 'before after'],
    ['<p>before<video>fallback</video>after</p>', 'before fallback after'],
    ['<p>before<video><a href="https://example.org/watch">fallback</a></video>after</p>', 'before fallback after'],
    ['before<video></video>after', 'before after'],
    ['<video></video>', ''],
  ]) {
    const cleaned = sanitizeBody(input!, base);
    assert.equal(stripTags(cleaned), expected, "removing a video preserves its text boundaries");
    assert.equal(sanitizeBody(cleaned, base), cleaned);
  }
});

test("a rejected poster never leaves an empty web or RSS player or hides its fallback link", () => {
  const rejected = 'poster="https://www.youtube.com/watch?v=example"';
  for (const absolute of [false, true]) {
    assert.equal(proxyBodyImages(`<video ${rejected} width="1280" height="720"></video>`, absolute), "");
    const fallback = proxyBodyImages(`<video ${rejected}><a href="https://example.org/watch">Watch elsewhere</a></video>`, absolute);
    assert.doesNotMatch(fallback, /<video|poster=/);
    assert.match(fallback, /<a href="https:\/\/example.org\/watch">Watch elsewhere<\/a>/);
    const playable = cheerio.load(proxyBodyImages(`<video src="https://example.org/clip.mp4" ${rejected}></video>`, absolute));
    assert.equal(playable("video").attr("src"), "https://example.org/clip.mp4");
    assert.equal(playable("video").attr("poster"), undefined);
    assert.ok(playable("video").is("[controls]"));
    for (const content of ["", "fallback", '<a href="https://example.org/watch">fallback</a>']) {
      const inline = proxyBodyImages(`<p>before<video ${rejected}>${content}</video>after</p>`, absolute);
      assert.equal(stripTags(inline), content ? "before fallback after" : "before after");
      assert.equal(proxyBodyImages(inline, absolute), inline);
    }
  }
});

test("translation, Markdown and public image outputs retain cleaned video candidates", () => {
  const html = sanitizeBody(`<p>Before.</p>${video}<video><source data-src="/clip.webm?token=webm&amp;quality=high" type="video/webm"><source src="/clip.mp4?token=mp4&amp;quality=high" type="video/mp4"></video><p>After.</p>`, base);
  const expectedSources = [
    ["https://publisher.example/clip.webm?token=webm&quality=high", "video/webm"],
    ["https://publisher.example/clip.mp4?token=mp4&quality=high", "video/mp4"],
  ];
  const sources = ($: cheerio.CheerioAPI) => $("video").eq(1).children("source").toArray().map((el) => [$(el).attr("src"), $(el).attr("type")]);
  const protectedBody = shield(html);
  assert.equal(sanitizeBody(unshield(protectedBody.html, protectedBody)!, base), html);
  const markdown = bodyToMarkdown(html, base);
  const restored = cheerio.load(markdownBody(markdown, base));
  assert.equal(restored("video").length, 2);
  assert.equal(restored("video").first().attr("src"), "https://publisher.example/clip.mp4?token=example&quality=high");
  assert.equal(restored("video").first().attr("poster"), "https://publisher.example/cover.jpg?token=poster&frame=1");
  assert.deepEqual(sources(restored), expectedSources);
  for (const absolute of [false, true]) {
    const output = cheerio.load(proxyBodyImages(html, absolute));
    assert.equal(output("video").length, 2);
    assert.deepEqual(sources(output), expectedSources);
    assert.equal(output("video").first().attr("src"), "https://publisher.example/clip.mp4?token=example&quality=high");
    assert.match(output("video").first().attr("poster")!, /\/api\/img-proxy\?/);
    assert.equal(new URL(output("video").first().attr("poster")!, base).searchParams.get("u"), "https://publisher.example/cover.jpg?token=poster&frame=1");
    assert.equal(output("video").first().attr("preload"), "none");
  }
});
