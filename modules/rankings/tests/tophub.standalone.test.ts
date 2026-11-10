import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseTopBoard, topBoards, topUrl } from "../backend/tophub.ts";

test("keeps source ranking, period and original link", () => {
  const board = topBoards.find(b => b.id === "tophub:day")!;
  assert.equal(topUrl(board), "https://open.tophub.today/hot?limit=1");
  const result = parseTopBoard(board, { status: 200, error: false, data: { day: "20261109", limit: 1, items: [
    { title: "热点", url: "https://example.com/a", sitename: "知乎", views: "100万热度" },
    { title: "标题", url: "javascript:alert(1)" },
  ] } });
  assert.equal(result.sourceUpdated, "2026-11-09");
  assert.deepEqual(result.items[0], { rank: 1, title: "热点", url: "https://example.com/a", origin: "知乎", heat: "100万热度", raw: { title: "热点", url: "https://example.com/a", sitename: "知乎", views: "100万热度" } });
  assert.equal(result.items[1].url, null);
  assert.throws(() => parseTopBoard(board, { status: 200, error: false, data: { limit: 7, items: [{}] } }));
});
