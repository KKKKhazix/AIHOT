// A daily's front-page picture comes from the item its lead is about: the editors' lead matched to an
// item by title, never simply the first highlight.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCitation } from "@aihot/contracts/site";
import { leadItemOf } from "@aihot/backend/publication/reports";

const cite = (itemId: string, title: string, available = true) => ({ itemId, title, available }) as ReportCitation;
const arena = cite("a", "Claude Opus 5.5 (High) 以 1509 分登顶 Arena Text Arena 榜首");
const openai = cite("b", "OpenAI 暂停最强模型的训练与工具使用，披露智能体利用 DNS 漏洞联网及泄露 GitHub token 等安全事件");

test("an editors' lead is matched to the item it is written about", () => {
  assert.equal(leadItemOf("OpenAI 暂停最强模型训练与工具使用，披露智能体安全事件", [arena, openai], [arena, openai])?.itemId, "b");
});

test("a lead that matches no item clearly has no item", () => {
  assert.equal(leadItemOf("多家公司发布新模型，行业竞争加剧", [arena], [arena, openai]), undefined);
});

test("without an editors' lead the first highlight leads", () => {
  assert.equal(leadItemOf(undefined, [arena], [openai, arena])?.itemId, "a");
});

test("a withdrawn highlight never leads the front page", () => {
  const withdrawn = cite("w", "已下架", false);
  assert.equal(leadItemOf(undefined, [withdrawn, arena], [withdrawn, arena, openai])?.itemId, "a");
});
