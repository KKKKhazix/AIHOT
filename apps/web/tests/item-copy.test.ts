// Failure mode: WeChat's in-app browser cannot save downloads, so the article offers "复制 Markdown" there
// instead; it copied with the async clipboard, which that browser does not have, and always failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { fakeApi, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

const markdown = "# 复制检查\n\n固定正文";

test("in WeChat, 复制 Markdown copies the article without the async clipboard", async () => {
  const api = fakeApi((url, res) => {
    if (url.pathname === "/api/site/items/wechat-copy") return itemDetail({ id: "wechat-copy", title: "复制检查" });
    if (url.pathname === "/items/wechat-copy/markdown") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      return res.end(markdown);
    }
  });
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50",
    });
    // As in WeChat: no async clipboard; a selection copy works, and what it copied is kept for the test.
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
      document.execCommand = (command: string) => {
        if (command !== "copy") return false;
        (window as { copied?: string }).copied = (document.activeElement as HTMLTextAreaElement | null)?.value;
        return true;
      };
    });
    const page = await context.newPage();
    await visit(page, web.origin + "/items/wechat-copy");
    await page.getByRole("button", { name: "更多操作" }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "复制 Markdown" }).click();
    await expect(page.getByRole("status")).toHaveText("Markdown 已复制");
    assert.equal(await page.evaluate(() => (window as { copied?: string }).copied), markdown);
  } finally {
    await browser.close();
    await web?.stop();
  }
});

test("desktop and phone share-card controls open the existing poster and preserve saving", async () => {
  const api = fakeApi((url,res) => {
    if(url.pathname==="/api/site/items/share-card")return itemDetail({id:"share-card",title:"卡片入口检查",summary:"需要分享的描述"});
    if(url.pathname==="/og/posters/share-card.png") {
      res.setHeader("Content-Type","image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><rect width="1080" height="1440" fill="#f5f6f5"/></svg>');
    }
  });
  const browser=await chromium.launch({channel:"chromium"});
  let web:WebServer|undefined;
  try {
    web=await startWebServer(api);
    for(const viewport of [{width:1366,height:900},{width:390,height:844}]) {
      const context=await browser.newContext({viewport});const page=await context.newPage();
      await visit(page,web.origin+"/items/share-card");
      if(viewport.width<1024) {
        await page.getByRole("button",{name:"更多操作"}).filter({visible:true}).click();
        await expect(page.getByRole("button",{name:"分享链接",exact:true})).toBeVisible();
        await page.keyboard.press("Escape");
      }
      const button=page.getByRole("button",{name:"分享卡片",exact:true}).filter({visible:true});
      await button.click();
      const dialog=page.getByRole("dialog",{name:"分享海报"});
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("img")).toBeVisible();
      await expect(dialog.getByRole("link",{name:"保存图片"})).toHaveAttribute("href","/og/posters/share-card.png");
      await page.keyboard.press("Escape");await expect(dialog).not.toBeVisible();
      await context.close();
    }
  } finally {await browser.close();await web?.stop();}
});
