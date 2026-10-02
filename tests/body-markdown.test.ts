import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readable } from "@aihot/backend/content/extract";
import { bodyToMarkdown, markdownToBody } from "@aihot/backend/content/markdown";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";

const url = "https://example.org/notices/one.html";
const imagePage = `<html><head><title>挂牌公告</title></head><body>
  <header><img src="/logo.png"><nav>首页 公司新闻 关于我们</nav></header>
  <div class="navigation">入市指南 会员中心 下载专区</div>
  <div class="article-content"><p><img src="/notice.png" alt="挂牌价公告"></p><div class="share">分享到</div></div>
  <footer>友情链接 联系我们 备案号</footer></body></html>`;

test("an image-only notice is extracted from its container, without menu, logo, share or footer", () => {
  const result = readable(imagePage, url, { selector: ".article-content", removeSelectors: [".share"] })!;
  assert.ok(result);
  assert.equal(result.markdown, "![挂牌价公告](https://example.org/notice.png)");
  assert.equal(result.text, "");
  assert.deepEqual(result.images.map((image) => image.url), ["https://example.org/notice.png"]);
  assert.doesNotMatch(result.html, /logo|首页|会员|分享|友情|备案/);
  assert.equal(readable(imagePage, url, { selector: ".missing" }), null);
  assert.equal(readable(imagePage, url, { selector: "div" }), null);
  assert.equal(readable(imagePage, url, { selector: ".article-content", removeSelectors: ["img", ".share"] }), null);
});

test("Markdown round trips article structure, prices, units, attachments and nested lists", () => {
  const html = `<h2>挂牌价格</h2><p>报价单位：美元/百万 token；示例体积单位：m<sup>3</sup>。</p>
    <table><caption>9 月 28 日</caption><thead><tr><th>品种</th><th align="right">价格</th></tr></thead>
    <tbody><tr><td>API | 企业版</td><td>4,200<br>含税</td></tr></tbody></table>
    <ol><li>签约<ul><li>提交资料</li></ul></li><li>交付</li></ol><blockquote><p>以原公告为准。</p></blockquote>
    <p><a href="/contract.pdf">合同附件</a></p><pre><code class="language-json">{"price":4200}</code></pre>`;
  const markdown = bodyToMarkdown(html, url);
  assert.match(markdown, /## 挂牌价格/);
  assert.match(markdown, /\| API \\\| 企业版 \| 4,200<br>含税 \|/);
  assert.match(markdown, /m<sup>3<\/sup>/);
  assert.match(markdown, /```json/);
  const rendered = markdownToBody(markdown, url);
  for (const token of ["<table>", "<ol>", "<ul>", "<blockquote>", "4,200", "<sup>3</sup>", "https://example.org/contract.pdf"]) assert.ok(rendered.includes(token), token);
  assert.doesNotMatch(markdownToBody('[unsafe](javascript:alert%281%29)<script>alert(1)</script><img src="x" onerror="alert(2)">'), /javascript:|<script|onerror/);
});

test("merged cells and headerless tables retain safe HTML without losing their structure", () => {
  for (const table of ["<table><tr><th colspan=2>报价</th></tr><tr><td>API</td><td>4200</td></tr></table>", "<table><tr><td>API</td><td>4200</td></tr></table>"]) {
    const markdown = bodyToMarkdown(table);
    assert.match(markdown, /<table>/);
    assert.match(markdownToBody(markdown), /<td>4200<\/td>/);
  }
});

test("body rule validation rejects malformed selectors and ignored keys", () => {
  assert.deepEqual(unsupportedConfig("web_list", { body: { selector: ".article-content", removeSelectors: [".share"] } }), []);
  for (const body of [{ selector: "[" }, { selector: "" }, { removeSelectors: ".share" }, { removeSelectors: [7] }, { typo: ".foo" }, null]) {
    assert.ok(unsupportedConfig("web_list", { body }).length, JSON.stringify(body));
  }
});
