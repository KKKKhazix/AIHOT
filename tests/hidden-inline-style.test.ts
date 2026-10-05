// Failure cases: an inline style hides a block in a way Readability's literal check misses (property or
// keyword in another case, "!important", an important declaration followed by a plain one), so text a
// reader never sees enters the body; or the reverse, a block a later declaration shows again is dropped;
// or settling the styles removes the hidden placeholder a noscript image is restored beside.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { readable } from "@aihot/backend/content/extract";

after(closeDb);

const prose = "The article explains the research methods, results and limitations, with original evidence for its conclusions. ".repeat(6);
const marker = "SECONDARY_MARKER: this block sits inside the article. ".repeat(6);
const page = (block: string) =>
  `<html><head><title>Research article</title></head><body><article><h1>Research article</h1><p>${prose}</p>${block}<p>${prose}</p></article></body></html>`;
const bodyWith = (style: string) => {
  const body = readable(page(`<div style="${style}"><p>${marker}</p></div>`), "https://example.com/article");
  assert.ok(body?.text.includes("research methods"), style);
  return body!.text.includes("SECONDARY_MARKER");
};

test("whatever a browser hides by inline style stays out of the body", () => {
  for (const style of [
    "display:none", "DISPLAY:NONE", "Display: None", "display:none !important", "display:none!important", "display: none ! IMPORTANT",
    "visibility:hidden", "VISIBILITY:HIDDEN", "visibility:hidden !important",
    "DISPLAY:none !important; display:block", "color:red; display:block; Display:none", "background:url(a;b.png); display:none",
  ]) assert.equal(bodyWith(style), false, style);
});

test("whatever a browser shows stays in the body", () => {
  for (const style of [
    "", "color:red", "display:block", "display:none; display:block", "display:none; DISPLAY:block", "visibility:hidden; visibility:visible",
    "display:none; display:block !important", "background:url(a;b.png)",
  ]) assert.equal(bodyWith(style), true, style);
});

test("a hidden placeholder still lets its noscript image through", () => {
  const body = readable(page(`<figure><img hidden src="/blank.gif"><noscript><img src="/real.jpg"></noscript><figcaption>Evidence chart</figcaption></figure>`), "https://example.com/article");
  assert.deepEqual(body?.images.map((image) => image.url), ["https://example.com/real.jpg"]);
});
