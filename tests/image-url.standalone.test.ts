import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonArticleImage } from "../packages/backend/src/lib/image-url.ts";

test("YouTube embed, /v/, and youtu.be pages are not article images", () => {
  assert.equal(isNonArticleImage("https://www.youtube.com/embed/dQw4w9WgXcQ"), true);
  assert.equal(isNonArticleImage("https://www.youtube.com/v/dQw4w9WgXcQ"), true);
  assert.equal(isNonArticleImage("https://youtu.be/dQw4w9WgXcQ"), true);
});

test("Vimeo watch and player pages are not article images", () => {
  assert.equal(isNonArticleImage("https://vimeo.com/123456789"), true);
  assert.equal(isNonArticleImage("https://player.vimeo.com/video/123456789"), true);
});
