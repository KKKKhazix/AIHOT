import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { markdownBody } from "@aihot/backend/content/markdown";

test("reader Markdown preserves block structure and still passes through the HTML whitelist", () => {
  const html = markdownBody(`Page title
# Article

_An italic note_ and **evidence**.

* First
  * Nested
* Second

| Model | Score |
| --- | --- |
| A | 10 |

\`\`\`python
first()

second()
\`\`\`

[source](/source) ![chart](/chart.png)
<script>alert(1)</script><img src="https://example.org/safe.png" onerror="alert(1)">
[unsafe](javascript:alert(1))`, "https://example.org/post");
  const $ = cheerio.load(html);
  assert.equal($("h2").text(), "Article", "a heading does not require a preceding blank line");
  assert.equal($("ul > li > ul > li").text(), "Nested");
  assert.equal($("table tbody td").last().text(), "10");
  assert.equal($("pre code").text(), "first()\n\nsecond()\n");
  assert.equal($("em").text(), "An italic note");
  assert.ok($('a[href="https://example.org/source"]').length);
  assert.ok($('img[src="https://example.org/chart.png"]').length);
  assert.doesNotMatch(html, /<script|onerror|javascript:/);
});

test("OpenAI Reader pages drop responsive navigation and recommendations, retaining captions and notes", () => {
  const url = "https://openai.com/index/example/";
  const input = `* [Products](https://openai.com/products/)

Introducing Example | OpenAI
# Example

Capabilities

* [Capabilities](${url}#capabilities)
  * [Coding](${url}#coding)

* [Capabilities](${url}#capabilities)

## Capabilities

The actual article.

_In_[_Benchmark⁠_⁠(opens in a new window)](https://example.org/benchmark)_, agents solve tasks._

## Author

OpenAI

_Evaluations may differ in production._

## Keep reading

[View all](https://openai.com/news/)

[Another article](https://openai.com/index/another/)

Footer navigation`;
  const html = markdownBody(input, url);
  const $ = cheerio.load(html);
  assert.deepEqual($("h2").map((_, e) => $(e).text()).get(), ["Example", "Capabilities", "Author"]);
  assert.equal($("ul").length, 0);
  assert.ok(html.includes("The actual article."));
  assert.ok(html.includes("Evaluations may differ in production."));
  assert.equal($('a[href="https://example.org/benchmark"]').text(), "Benchmark⁠⁠(opens in a new window)");
  assert.doesNotMatch($("body").text(), /Products|Introducing Example|Keep reading|Another article|Footer|_/);
  assert.ok(markdownBody(input, "https://example.org/index/example/").includes("Footer navigation"), "publisher-specific boundaries must not trim unrelated publishers");
});
