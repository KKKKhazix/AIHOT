// Failure cases: the provider's escaped ampersands/comparisons remain visible in plain-text posts;
// stripping HTML destroys literal code; repeated decoding changes a deliberately written entity;
// quote text follows another rule, or decoding corrupts an already expanded destination URL.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { tweetText, type SdTweet } from "@aihot/backend/providers/socialdata";
import { tweetToCandidate } from "@aihot/backend/sources/x";

const post = (text: string): SdTweet => ({ id_str: "123", tweet_created_at: "2026-10-01T00:00:00.000Z", full_text: text, user: { name: "Example", screen_name: "example" } });

test("post text decodes the provider's three HTML escapes exactly once without stripping code", () => {
  const input = "Work &amp; healthcare; a &lt; b &gt; c.\nKeep <tag> and the literal &amp;lt;.";
  const expected = "Work & healthcare; a < b > c.\nKeep <tag> and the literal &lt;.";
  assert.equal(tweetText(post(input)), expected);
  assert.equal(tweetText({ ...post(input), full_text: undefined, text: input }), expected);
});

test("the post title, body and quote share decoding while expanded links and media stay intact", () => {
  const expanded = "https://example.test/?literal=&amp;value=1";
  const input = post("Research &amp; development\nhttps://t.co/link https://t.co/media");
  input.entities = { urls: [{ url: "https://t.co/link", expanded_url: expanded }] };
  input.extended_entities = { media: [{ type: "photo", media_url_https: "https://example.test/media.png" }] };
  input.quoted_status = post("value &lt; 3 &amp; value &gt; 0");
  const out = tweetToCandidate(input);
  assert.equal(out.title, "Research & development");
  assert.equal(out.xPost?.text, `Research & development\n${expanded}`);
  assert.equal(out.xPost?.quoted?.text, "value < 3 & value > 0");
  assert.equal(out.bodyText, `Research & development\n${expanded}\n\n【引用 @example】value < 3 & value > 0`);
  assert.equal(out.media?.[0]?.url, "https://example.test/media.png");
});
