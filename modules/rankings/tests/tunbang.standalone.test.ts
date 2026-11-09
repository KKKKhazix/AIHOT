import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseBoard, parseDirectory } from "../backend/tunbang.ts";

test("discovers only valid distinct board links from the directory", () => {
  const boards = parseDirectory('<section id="all-bangs"><a class="catcard" href="/hot/weibo/"><h3>微博热搜</h3></a><a class="catcard" href="/hot/weibo/"><h3>重复</h3></a><a class="catcard" href="https://elsewhere.test/hot/x/"><h3>外站</h3></a></section>');
  assert.deepEqual(boards.map(b => b.id), ["tunbang:all", "tunbang:weibo"]);
});

test("preserves rank, heat, source and safe article links", () => {
  const { items, sourceUpdated } = parseBoard('<p class="updated">数据更新于 2026-11-07 10:30</p><ol id="list"><li class="row"><span class="rank">2</span><a class="row-title" href="https://example.org/a?x=1&amp;y=2">标题</a><div class="row-sub"><span class="chip">微博</span><span class="hot">20万</span></div></li><li class="row"><span class="rank">3</span><a class="row-title" href="javascript:alert(1)">不安全</a></li></ol>');
  assert.equal(sourceUpdated, "2026-11-07 10:30");
  assert.deepEqual(items[0], { rank: 2, title: "标题", url: "https://example.org/a?x=1&y=2", heat: "20万", origin: "微博" });
  assert.equal(items[1].url, null);
  assert.throws(() => parseBoard("<html></html>"));
});
