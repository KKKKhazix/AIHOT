// Regression for issue #478: an English body that merely links to 「简体中文」 carries a handful
// of Han characters in thousands of letters, was treated as Chinese, and its full-text
// translation was silently skipped. Long bodies now need a substantial Han share; short
// strings (titles, posts, quotes) keep the presence test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isChineseText, isSubstantiallyChinese } from "../packages/backend/src/lib/text.ts";

const english = "Let AI use your phone, fully offline. ".repeat(400);

test("an English body with a stray Simplified-Chinese link is not Chinese", () => {
  const body = english + "简体中文";
  assert.equal(isChineseText(body, null), true, "presence test: the old behaviour");
  assert.equal(isSubstantiallyChinese(body, null), false, "the body is overwhelmingly English");
});

test("a genuinely Chinese body is substantially Chinese", () => {
  assert.equal(isSubstantiallyChinese("这是一段真正用中文写成的长正文，讲的是模型与智能体。".repeat(120), null), true);
});

test("a declared language still wins outright", () => {
  assert.equal(isSubstantiallyChinese(english, "en"), false);
  assert.equal(isSubstantiallyChinese("hello", "zh"), true);
});

test("Japanese kana stays non-Chinese even with many Han characters", () => {
  assert.equal(isSubstantiallyChinese("これはテストの文章です。".repeat(300), null), false);
});

test("short strings keep the presence test", () => {
  assert.equal(isSubstantiallyChinese("BLA 开源发布", null), true);
  assert.equal(isSubstantiallyChinese("Hello 世界", null), true);
});
