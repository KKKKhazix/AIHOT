// Failure cases observed in streamed pages: the real article remains hidden in a completed segment,
// the loading fallback is mistaken for content, nested boundaries lose paragraphs, or a broad hidden
// cleanup exposes unrelated hidden text. Missing boundary markers and script examples must stay inert.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readable } from "@aihot/backend/content/extract";

const prose = "This original article explains how agents coordinate their work, preserving evidence and reviewing changes before publication. ".repeat(12);
const content = `<article><h1>Agent collaboration</h1><p>${prose}</p></article>`;
const page = (body: string) => `<html><head><title>Agent collaboration</title></head><body>${body}</body></html>`;
const boundary = (id: string, fallback = "LOADING_FALLBACK") => `<!--$?--><template id="B:${id}"></template><p>${fallback}</p><!--/$-->`;
const segment = (id: string, html = content) => `<div hidden id="S:${id}">${html}</div>`;
const finish = (id: string) => `<script>$RC("B:${id}","S:${id}")</script>`;

test("completed streamed content replaces the fallback at its boundary", () => {
  const body = readable(page(`<main>${boundary("3")}</main>${segment("3")}${finish("3")}`), "https://example.org/article");
  assert.ok(body);
  assert.ok(body.text.includes("agents coordinate their work"));
  assert.ok(!body.text.includes("LOADING_FALLBACK"));
});

test("nested completed segments preserve article order and leave unrelated hidden text hidden", () => {
  const inner = `<p>SECOND_PART ${prose}</p><div hidden><p>HIDDEN_PRIVATE ${prose}</p></div>`;
  const outer = `<article><h1>Agent collaboration</h1><p>FIRST_PART ${prose}</p>${boundary("1")}<p>THIRD_PART ${prose}</p></article>`;
  const html = page(`${boundary("0")}${segment("0", outer)}${segment("1", inner)}${finish("1")}${finish("0")}${segment("unused", `<p>UNREFERENCED ${prose}</p>`)}`);
  const body = readable(html, "https://example.org/article");
  assert.ok(body);
  assert.ok(body.text.includes("SECOND_PART"));
  assert.ok(body.text.indexOf("FIRST_PART") < body.text.indexOf("SECOND_PART"));
  assert.ok(body.text.indexOf("SECOND_PART") < body.text.indexOf("THIRD_PART"));
  assert.ok(!/HIDDEN_PRIVATE|UNREFERENCED|LOADING_FALLBACK/.test(body.text));
});

test("the inline runtime definition may end with a completion call", () => {
  const html = page(`${boundary("0")}${segment("0")}<script>$RC=function(a,b){throw new Error("MUST_NOT_EXECUTE")};$RC("B:0","S:0")</script>`);
  assert.ok(readable(html, "https://example.org/article")?.text.includes("agents coordinate"));
});

test("incomplete boundaries and calls inside data, strings, comments or examples do not expose hidden text", () => {
  for (const instruction of [
    "", '<script type="application/json">$RC("B:1","S:1")</script>',
    '<script>const example = \'$RC("B:1","S:1")\';</script>',
    '<script>/* $RC("B:1","S:1") */</script>', '<script>// $RC("B:1","S:1")</script>',
  ]) {
    const html = page(`${content}${boundary("1")}${segment("1", `<article><p>HIDDEN_PRIVATE ${prose}</p></article>`)}${instruction}`);
    assert.ok(!readable(html, "https://example.org/article")?.text.includes("HIDDEN_PRIVATE"));
  }
  const broken = page(`${content}<template id="B:1"></template>${segment("1", `<article><p>HIDDEN_PRIVATE ${prose}</p></article>`)}${finish("1")}`);
  assert.ok(!readable(broken, "https://example.org/article")?.text.includes("HIDDEN_PRIVATE"));
});
