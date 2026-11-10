import { strict as assert } from "node:assert";
import { test } from "node:test";
import { wxBoards, wxUrl, parseWxBoard } from "../backend/wxrank.ts";

test("uses the anonymous default period and preserves account metrics", () => {
  const board = wxBoards.find(b => b.id === "wxrank:account")!;
  assert.equal(wxUrl(board), "https://wxrank.com/api/rank/account?range=30d&page=1");
  const result = parseWxBoard(board, { code: 0, data: { stat_date: "2026-11-08", list: [{ rank_no: 1, wx_name: "账号", wx_type: "教育", read_avg: 100001, wci_index: "1234.50" }] } });
  assert.equal(result.sourceUpdated, "2026-11-08");
  assert.deepEqual(result.items[0], { rank: 1, title: "账号", url: null, heat: "", origin: "教育", metrics: "平均阅读 10万+ · WCI 1234.5", raw: { rank_no: 1, wx_name: "账号", wx_type: "教育", read_avg: 100001, wci_index: "1234.50" } });
});

test("handles public articles and rejects login responses", () => {
  const board = wxBoards.find(b => b.id === "wxrank:article")!;
  assert.match(wxUrl(board), /range=7d&page=1$/);
  const result = parseWxBoard(board, { code: 0, data: { list: [{ rank_no: 2, title: "文章", wx_name: "账号", art_url: "javascript:alert(1)", read_num: 500, hot_score: 88 }] } });
  assert.equal(result.items[0].url, null);
  assert.equal(result.items[0].metrics, "阅读 500 · 热度分 88");
  assert.throws(() => parseWxBoard(board, { code: 401, message: "请先登录", data: [] }), /请先登录/);
});
