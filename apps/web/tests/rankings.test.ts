import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";
const common = { items: [], sourceUpdated: null, fetchedAt: null, failed: false };
const boards = [
  { ...common, id: "tunbang:all", name: "全网热搜总榜", source: "豚榜", url: "https://tunbang.com/hot/", items: [{ rank: 1, title: "测试热点", url: "https://example.org/", heat: "10万", origin: "微博" }] },
  { ...common, id: "wxrank:article", name: "热门文章", source: "微小榜", url: "https://wxrank.com/rank/article", unavailable: "榜单接口需要登录或授权，暂未接入。" },
];
let web: WebServer; let browser: Browser;
before(async () => { web = await startWebServer(fakeApi(url => url.pathname === "/api/site/rankings" ? { boards } : undefined)); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });
for (const width of [393, 1200]) test(`rankings search and selection at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  try {
    await visit(page, `${web.origin}/rankings`);
    await expect(page.getByRole("link", { name: "测试热点 ↗" })).toBeVisible();
    if (width < 961) await page.getByRole("button", { name: /选择榜单/ }).click();
    await page.getByRole("searchbox", { name: "搜索榜单或来源" }).fill("微小榜");
    await page.getByRole("button", { name: "热门文章" }).click();
    await expect(page.getByText("榜单接口需要登录或授权，暂未接入。")).toBeVisible();
    await expect(page).toHaveURL(/board=wxrank/);
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    if (size.scroll > size.width + 1) throw new Error(`page overflows: ${size.scroll} > ${size.width}`);
  } finally { await page.close(); }
});
