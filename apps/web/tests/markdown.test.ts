// Links in the site's own copy (terms, privacy): the site's own address stays on the site, whatever
// domain it is deployed at; any other address opens in a new tab.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../app/lib/markdown.ts";

const SITE = "https://news.example.com";
const link = (md: string) => /<a [^>]*>/.exec(renderMarkdown(md, SITE).html)?.[0];

test("a link to the site's own address becomes an in-site path", () => {
  assert.equal(link("[关于](https://news.example.com/about)"), '<a href="/about">');
  assert.equal(link("[首页](https://news.example.com)"), '<a href="/">');
  assert.equal(link("[隐私](/privacy)"), '<a href="/privacy">');
});

test("any other address opens in a new tab", () => {
  assert.equal(link("[别处](https://other.example.org/about)"), '<a href="https://other.example.org/about" target="_blank" rel="noopener noreferrer">');
  assert.equal(link("[别的站](https://news.example.com.evil.test/about)"), '<a href="https://news.example.com.evil.test/about" target="_blank" rel="noopener noreferrer">');
});
