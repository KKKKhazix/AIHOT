import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import { fakeApi, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

// Failure mode (#182 left half-fixed): between lg and 2xl the outline sits under the right rail's other
// blocks; on a 1366x657 laptop window only one entry was visible, and a little shorter the rail grew
// past the window again so the later entries could not be reached at all.
test("a short laptop window keeps several outline entries and can reach the last one", async () => {
  const outline = Array.from({ length: 40 }, (_, i) => ({ id: `section-${i}`, level: 2, text: `Section ${i}` }));
  const item = itemDetail({
    id: "outline-short", title: "目录可达检查", reason: "固定推荐理由。".repeat(12), tags: ["标签甲", "标签乙", "标签丙"], outline,
    body: { zh: outline.map((o) => `<h2 id="${o.id}">${o.text}</h2><p>${"固定正文。".repeat(100)}</p>`).join(""), original: null, zhKind: "original", complete: true },
  });
  const api = fakeApi((url) => (url.pathname === "/api/site/items/outline-short" ? item : undefined));
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    for (const height of [657, 560]) {
      const page = await browser.newPage({ viewport: { width: 1366, height }, reducedMotion: "reduce" });
      await page.goto(web.origin + "/items/outline-short");
      const nav = page.getByRole("navigation", { name: "本文目录" });
      await expect(nav).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const entry = await nav.locator("a").first().evaluate((a) => a.getBoundingClientRect().height);
      assert.ok((await nav.evaluate((n) => n.clientHeight)) >= entry * 5, `${height}px: the outline shows at least five entries`);
      const last = nav.locator("a").last();
      await last.scrollIntoViewIfNeeded();
      const box = await last.evaluate((a) => { const r = a.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
      assert.ok(box.top >= 0 && box.bottom <= height, `${height}px: the last entry can be brought into the window`);
      await page.close();
    }
  } finally {
    await browser.close();
    await web?.stop();
  }
});

// WebKit can send Home/End to the page even when an overflowing outline contains CSS overscroll.
test("outline keyboard scrolling stays inside its boundary in WebKit", async () => {
  const outline = Array.from({ length: 40 }, (_, i) => ({ id: `section-${i}`, level: 2, text: `Section ${i}` }));
  const item = itemDetail({ id: "outline-keys", title: "键盘目录检查", outline,
    body: { zh: outline.map(o => `<h2 id="${o.id}">${o.text}</h2><p>${"固定正文。".repeat(100)}</p>`).join(""), original: null, zhKind: "original", complete: true },
  });
  const web = await startWebServer(fakeApi(url => url.pathname === "/api/site/items/outline-keys" ? item : undefined));
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    await visit(page, web.origin + "/items/outline-keys");
    const nav = page.getByRole("navigation", { name: "本文目录" });
    await expect(nav).toBeVisible();
    for (const [boundary, keys] of [["end", ["End", "PageDown", "ArrowDown", "Space"]], ["start", ["Home", "PageUp", "ArrowUp", "Shift+Space"]]] as const) {
      for (const key of keys) {
        await page.evaluate(() => window.scrollTo(0, 800));
        await nav.evaluate((n, boundary) => {
          n.scrollTop = boundary === "end" ? n.scrollHeight : 0;
          n.querySelector<HTMLElement>(boundary === "end" ? "li:last-child a" : "li:first-child a")!.focus({ preventScroll: true });
        }, boundary);
        const before = await page.evaluate(() => scrollY);
        await page.keyboard.press(key);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.equal(await page.evaluate(() => scrollY), before, `${key} stays inside the outline at its ${boundary}`);
      }
    }
    await expect(nav).toHaveAttribute("tabindex", "0");
    await nav.evaluate(n => { n.scrollTop = 0; n.focus({ preventScroll: true }); });
    await page.keyboard.press("PageDown");
    await expect.poll(() => nav.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
  } finally {
    await browser.close();
    await web.stop();
  }
});
