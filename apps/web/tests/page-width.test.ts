// Failures: an unbroken URL in a report's lead widened the phone layout and pushed the fifth tab off
// screen; an open "另外 N 家也报道了" took its longest title's width and scrolled a narrow desktop window
// sideways (2026-10-16). Pages must fit the window at phone, narrow-phone, unfolded-foldable (669) and
// narrowest-desktop (941) widths. Narrow desktops read in one column (2026-10-30): what a side column holds
// there (an article's reason, topics, original and outline; the switch between reports) must stay within reach.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit, expect, type Browser, type Page } from "@playwright/test";
import type { ReportDetail, ReportKind } from "@aihot/contracts/site";
import { FIXTURE_AT as at, fakeApi, feedItem, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

const longText = "查看完整说明 https://example.org/announcements/" + "a".repeat(100) + "。";
const longTitle = "一条很长的标题".repeat(30);
const keys = { daily: "2026-10-15", weekly: "2026-W42", monthly: "2026-10" };
const groupCard = { key: "g1", anchorAt: at, item: feedItem({ id: "rep-1", title: "代表文章" }), group: { factId: "f1", additionalSourceCount: 1, reportCount: 2, memberIds: ["rep-1"] } };
const outline = Array.from({ length: 4 }, (_, i) => ({ id: `part-${i}`, level: 2, text: `第${i + 1}部分` }));
const article = itemDetail({
  id: "fit", title: "宽度检查文章", topics: [{ slug: "fixture-topic", name: "固定主题" }], outline,
  body: { zh: outline.map((o) => `<h2 id="${o.id}">${o.text}</h2><p>${"固定正文。".repeat(40)}</p>`).join(""), original: null, zhKind: "original", complete: true },
});

const api = fakeApi((url) => {
  const path = url.pathname;
  if (path === "/api/site/items/fit") return article;
  if (path === "/api/site/topics") return { groups: [], topics: [] };
  if (path === "/api/site/hot") return { computedAt: at, windowHours: 48, entries: [] };
  if (path === "/api/site/timeline") return { filters: { channel: "all", category: null, tag: null }, cards: [groupCard], nextCursor: null, hot: null, dayCounts: { "2026-10-04": 1 } };
  if (path === "/api/site/groups/f1/reports") {
    return { factId: "f1", reports: [
      { id: "rep-1", title: "代表文章", source: { name: "Fixture" }, timelineAt: at, originalUrl: "https://example.org/1" },
      { id: "other-2", title: longTitle, source: { name: "Fixture" }, timelineAt: at, originalUrl: "https://example.org/2" },
    ] };
  }
  const match = /^\/api\/site\/reports\/(daily|weekly|monthly)\/latest-page$/.exec(path);
  if (match) {
    const kind = match[1] as ReportKind;
    const report: ReportDetail = {
      kind, key: keys[kind], issueNumber: 1, title: "报告宽度", generatedAt: "2026-10-15T00:00:00Z",
      lead: { title: "今日头条", leadParagraph: longText }, leadItemId: "fixture", overview: longText,
      highlights: [], sections: [{ label: "动态", summary: null, items: [{ itemId: "fixture", title: "今日头条", summary: longText, sourceName: "Fixture", sourceUrl: "https://example.org/article", sourceIconUrl: null, firstParty: true, publishedAt: null, available: true }] }],
      flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null,
    };
    return { index: [{ key: report.key, issueNumber: 1 }], report };
  }
});
let web: WebServer;
let chrome: Browser;
let safari: Browser;
before(async () => {
  web = await startWebServer(api);
  chrome = await chromium.launch({ channel: "chromium" });
  safari = await webkit.launch();
});
after(async () => { await chrome?.close(); await safari?.close(); await web?.stop(); });

/** Each page with what widened it: a report's long lead, and the home list with its reading group open. */
const PAGES: Array<{ path: string; ready: (page: Page, width: number) => Promise<void> }> = [
  ...["daily", "weekly", "monthly"].map((kind) => ({
    path: `/${kind}`,
    ready: async (page: Page) => {
      await expect(page.getByRole("heading", { name: "今日头条", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "周报", exact: true }).filter({ visible: true })).toBeVisible();
    },
  })),
  {
    path: "/items/fit",
    ready: async (page: Page) => {
      await expect(page.getByText("固定推荐理由", { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "固定主题" }).filter({ visible: true })).toBeVisible();
      await expect(page.getByRole("link", { name: /原文/ }).filter({ visible: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "目录", exact: true }).filter({ visible: true }).click();
      await expect(page.getByRole("dialog", { name: "目录" }).getByRole("link", { name: "第4部分" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "目录" })).toBeHidden();
    },
  },
  {
    path: "/",
    ready: async (page: Page, width: number) => {
      // Desktop opens the group in place; phones open it in a sheet.
      if (width < 941) return expect(page.getByRole("link", { name: "代表文章", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "另外 1 家也报道了" }).filter({ visible: true }).click();
      await expect(page.getByRole("link", { name: longTitle })).toBeVisible();
    },
  },
];

/**
 * What reaches past the screen's right edge: the page's own scrolling width (overflowing text), and boxes
 * drawn past it outside the ones that scroll or clip their content sideways.
 */
function pastEdge(width: number): string[] {
  const clipped = (el: Element) => {
    for (let box = el.parentElement; box; box = box.parentElement) if (getComputedStyle(box).overflowX !== "visible") return true;
    return false;
  };
  const page = document.documentElement.scrollWidth;
  return [
    ...(page > width + 1 ? [`the page scrolls to ${page}px`] : []),
    ...[...document.body.querySelectorAll("*")].flatMap((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.right > width + 1 && !clipped(el) ? [`${el.tagName.toLowerCase()} "${el.textContent!.slice(0, 20)}" ends at ${Math.round(box.right)}px`] : [];
    }),
  ];
}

for (const engine of ["Chromium", "WebKit"] as const) test(`${engine}: pages stay within the screen at 320, 393, 669 and 941 pixels`, async () => {
  for (const width of [393, 320, 669, 941]) {
    const context = await (engine === "Chromium" ? chrome : safari).newContext({ viewport: { width, height: 873 }, isMobile: width < 941, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      for (const { path, ready } of PAGES) {
        await visit(page, web.origin + path);
        await ready(page, width);
        assert.deepEqual(await page.evaluate(pastEdge, width), [], `${path} at ${width}px`);
      }
    } finally { await context.close(); }
  }
});
