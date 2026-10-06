import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonArticleImage } from "../packages/backend/src/lib/image-url.ts";

test("YouTube watch and shorts pages are not article images", () => {
  assert.equal(isNonArticleImage("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
  assert.equal(isNonArticleImage("https://youtube.com/shorts/abcdefghijk"), true);
});

test("YouTube embed, /v/, and youtu.be pages are not article images", () => {
  assert.equal(isNonArticleImage("https://www.youtube.com/embed/dQw4w9WgXcQ"), true);
  assert.equal(isNonArticleImage("https://www.youtube.com/v/dQw4w9WgXcQ"), true);
  assert.equal(isNonArticleImage("https://youtu.be/dQw4w9WgXcQ"), true);
});

test("Vimeo watch and player pages are not article images", () => {
  assert.equal(isNonArticleImage("https://vimeo.com/123456789"), true);
  assert.equal(isNonArticleImage("https://player.vimeo.com/video/123456789"), true);
});

test("real image hosts stay eligible", () => {
  assert.equal(isNonArticleImage("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"), false);
  assert.equal(isNonArticleImage("https://example.com/photo.png"), false);
});

test("1x1 tracking pixels are rejected", () => {
  assert.equal(isNonArticleImage("https://example.com/pixel.gif", "1", "1"), true);
});
