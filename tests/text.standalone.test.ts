import assert from "node:assert/strict";
import { test } from "node:test";
import { looksZh } from "@aihot/backend/editorial/writing";
import { isChineseBody, exportTranslation } from "@aihot/backend/publication/items";
import { stripTags } from "@aihot/backend/lib/text";
import { displayTag } from "@aihot/contracts/taxonomy";

// Regression coverage for HTML attributes that contain `>` in real source pages.
test("stripTags ignores > inside quoted HTML attributes", () => {
  assert.equal(
    stripTags('<a title="Platforms > Xbox [11,780 articles]" href="/xbox">Xbox</a>'),
    "Xbox",
  );
  assert.equal(stripTags("<a title='Platforms > Xbox' href='/xbox'>A > B</a>"), "A > B");
  assert.equal(stripTags(`<a title = "don't > do" href = '/xbox'>Xbox</a>`), "Xbox");
  assert.equal(stripTags(`<a\ttitle\n=\f"Platforms > Xbox" href='/xbox'>Xbox</a>`), "Xbox");
});

test("stripTags does not pair quotes inside unquoted attribute values", () => {
  assert.equal(stripTags("<a title=don't>Xbox</a><p>next paragraph</p>"), "Xbox next paragraph");
  assert.equal(stripTags("<a title=don't>Xbox</a><p title=it's>next paragraph</p>"), "Xbox next paragraph");
  assert.equal(stripTags(`<a data-note=a='b title="Platforms > Xbox">Xbox</a>`), "Xbox");
});

test("stripTags keeps existing comment handling without swallowing following text", () => {
  for (const comment of ["<!-- note -->", "<!-->", "<!--->", "<!-- note --!>", "<!-- don't -->"]) {
    assert.equal(stripTags(`${comment}<p>visible article</p>`), "visible article");
  }
});

test("stripTags preserves existing spacing, entities, and hidden-content handling", () => {
  assert.equal(stripTags("<p>one</p><p>two</p>"), "one two");
  assert.equal(stripTags("a<br>b"), "a b");
  assert.equal(stripTags("<script>hidden</script><style>hidden</style><noscript>hidden</noscript>visible"), "visible");
  assert.equal(stripTags("&nbsp;&amp; &lt;code&gt; &quot;text&quot; &#39;one&apos;"), '& <code> "text" \'one\'');
});

test("stripTags keeps existing handling of incomplete tags and unclosed attribute quotes", () => {
  assert.equal(stripTags('text <a title="unfinished'), 'text <a title="unfinished');
  assert.equal(stripTags('text <a title="unfinished>visible'), "text");
  assert.equal(stripTags('<a ="unfinished>y">tail'), 'y">tail');
});

// Feeds escape text twice, so a title arrives as "AI&#8217;s leaders" and code as "mtime:&amp;lt;7d":
// character references are text too, and the text meant is what a reader expects.
test("stripTags decodes character references, also when a feed escaped them twice", () => {
  assert.equal(stripTags("AI&#8217;s leaders, AT&#038;T &#x2014; done&#8230;"), "AI’s leaders, AT&T — done…");
  assert.equal(stripTags("AI&amp;#8217;s &amp;lt;7d&gt;"), "AI’s <7d>");
  assert.equal(stripTags("Gemini &mdash; &ldquo;fast&rdquo; &amp;hellip; caf&eacute; 5&times;"), "Gemini — “fast” … café 5×");
  // Only references that end in a semicolon: an address keeps "&copy=" and an unknown name stays as written.
  assert.equal(stripTags("?a=1&copy=2 &unknown; AT&T"), "?a=1&copy=2 &unknown; AT&T");
});

test("writing and public reading agree about Chinese, including Japanese with kanji", () => {
  for (const body_text of ["新しい人工知能モデルを公開しました。", "人工知能 모델을 공개했습니다."]) {
    assert.equal(looksZh(body_text), false);
    for (const language of [null, "ja", "ko"]) {
      assert.equal(isChineseBody({ language, body_text }), false);
      assert.equal(exportTranslation({ language, body_text, tr_html: "<p>发布了新模型。</p>", tr_complete: true }), "<p>发布了新模型。</p>");
    }
  }
  assert.equal(isChineseBody({ language: "ja", body_text: "人工知能研究開発" }), false);
  assert.equal(isChineseBody({ language: null, body_text: "新的人工智能模型发布了。" }), true);
  assert.equal(isChineseBody({ language: "zh-Hans", body_text: "API" }), true);
  assert.equal(isChineseBody({ language: "en", body_text: "An English article quoting 人工智能." }), false);
});

test("displayTag maps slash tags to clean labels, hides internal filter tags, and keeps ordinary tags", () => {
  assert.equal(displayTag("开源/仓库"), "开源");
  assert.equal(displayTag("部署/工程"), "工程部署");
  assert.equal(displayTag("非AI/通用工具"), null);
  assert.equal(displayTag("OpenAI"), "OpenAI");
});
