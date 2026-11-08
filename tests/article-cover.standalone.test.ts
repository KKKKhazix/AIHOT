// Failure cases: an article whose page shows its picture only above the text (techcrunch.com, theverge.com,
// news.mit.edu: the publisher's cover sits in the page header, outside what Readability reads) was stored and
// shown as a wall of text. GitHub and Hugging Face draw a card of a page's text for its share picture.
// (Which declared pictures are the site's own is decided with the store, in article-cover.test.ts.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { readable } from "@aihot/backend/content/extract";
import { withCover } from "@aihot/backend/content/cover";

const prose = "The article explains how the new model was trained and evaluated, with measurements. ".repeat(6);
const page = (head: string, body = `<p>${prose}</p><p>${prose}</p>`) =>
  `<html><head><title>Story</title>${head}</head><body><article><h1>Story</h1>${body}</article></body></html>`;
const og = (url: string, extra = "") => `<meta property="og:image" content="${url}">${extra}`;

test("a page's declared share picture is the cover of a body without pictures of its own", () => {
  const got = readable(page(og("/images/cover.jpg", '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="A lab bench">')), "https://publisher.example/news/story");
  assert.deepEqual(got?.cover, { url: "https://publisher.example/images/cover.jpg", width: 1200, height: 630, alt: "A lab bench" });
  assert.deepEqual(got?.images, [], "the cover is not one of the body's pictures");
  assert.doesNotMatch(got!.html, /cover\.jpg/, "nor part of the stored body");
  const twitter = readable(page('<meta name="twitter:image" content="https://cdn.publisher.example/t.jpg">'), "https://publisher.example/news/story");
  assert.equal(twitter?.cover?.url, "https://cdn.publisher.example/t.jpg");
  const pictured = readable(page(og("/images/cover.jpg"), `<p>${prose}</p><figure><img src="/images/chart.png" alt="Chart"><figcaption>Scores by model.</figcaption></figure><p>${prose}</p>`), "https://publisher.example/news/story");
  assert.equal(pictured?.cover, null, "a body with a picture of its own takes none");
  assert.equal(readable(page(""), "https://publisher.example/news/story")?.cover, null);
  const card = readable(page(og("https://opengraph.githubassets.com/3bd6/owner/repo/releases/tag/v2.1.0")), "https://github.com/owner/repo/releases/tag/v2.1.0");
  assert.equal(card?.cover, null, "GitHub's generated card of a release's text is no picture");
  const model = readable(page(og("https://cdn-thumbnails.huggingface.co/social-thumbnails/models/owner/Model-9B-GGUF.png")), "https://huggingface.co/owner/Model-9B-GGUF");
  assert.equal(model?.cover, null, "nor Hugging Face's card of a model's name");
});

test("pages show the cover above a body without pictures of its own, in either language", () => {
  const cover = { url: "https://cdn.publisher.example/c.jpg?w=1200&h=630", width: 1200, height: 630, alt: 'A "quoted" lab' };
  const original = "<p>The model is available today.</p>";
  const figure = '<figure><img src="https://cdn.publisher.example/c.jpg?w=1200&amp;h=630" alt="A &quot;quoted&quot; lab" width="1200" height="630"></figure>';
  assert.equal(withCover(original, cover, original), figure + original);
  assert.equal(withCover("<p>模型今天开放。</p>", cover, original), `${figure}<p>模型今天开放。</p>`, "the original decides, so both languages agree");
  const pictured = `${original}<p><img src="https://cdn.publisher.example/chart.png"></p>`;
  assert.equal(withCover(pictured, cover, pictured), pictured);
  assert.equal(withCover(original, null, original), original);
  assert.equal(withCover(original, { ...cover, width: null, height: null, alt: null }, original), '<figure><img src="https://cdn.publisher.example/c.jpg?w=1200&amp;h=630" alt=""></figure>' + original);
});
