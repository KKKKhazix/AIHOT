// Failure modes fixed before changing admin loading and formatting:
// - a slow/failed navigation badge prevents the actual page from opening;
// - streaming exposes a page before identity is verified, or makes private data cacheable;
// - desktop/phone badges disappear permanently or retain the preceding page's values;
// - hovering private links reads an expensive page that no-store makes navigation read again;
// - reusing number formatters changes rounding, missing values, or currency precision.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { money, num } from "../app/features/admin/format.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
let browser: Browser;
let signedIn = true;
let badge = 7;
let badgeFailure = false;
let releaseBadges: (() => void) | undefined;
let badgeGate: Promise<void> | undefined;
const reads: string[] = [];
const api = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://api.local");
  if (url.pathname.startsWith("/api/admin/")) reads.push(url.pathname);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: null }));
  if (url.pathname.startsWith("/api/admin/") && !signedIn) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ detail: "unauthorized" }));
  }
  if (url.pathname === "/api/admin/me") return res.end(JSON.stringify({ name: "后台性能检查", csrf: "fixture", dev: true }));
  if (url.pathname === "/api/admin/nav-counts") {
    await badgeGate;
    res.statusCode = badgeFailure ? 503 : 200;
    return res.end(JSON.stringify(badgeFailure ? { detail: "busy" } : { sources: badge }));
  }
  if (url.pathname === "/api/admin/sources") return res.end(JSON.stringify({ rows: [], totals: { total: 0, enabled: 0, failing: 0, degraded: 0 }, page: 1 }));
  res.statusCode = 404;
  res.end(JSON.stringify({ detail: "not_found" }));
});

before(async () => {
  web = await startWebServer(api);
  browser = await chromium.launch({ channel: "chromium" });
});
after(async () => {
  releaseBadges?.();
  await browser?.close();
  await web?.stop();
});

function holdBadges() {
  badgeGate = new Promise<void>((resolve) => { releaseBadges = resolve; });
}
function resumeBadges() {
  releaseBadges?.();
  releaseBadges = undefined;
  badgeGate = undefined;
}

test("admin HTML and navigation begin before delayed badges while remaining private", async () => {
  for (const path of ["/admin/content", "/admin/content.data?_routes=admin-layout,routes/admin/content"]) {
    holdBadges();
    // SSR deliberately waits for every boundary for bots; this is a browser document request.
    const response = fetch(web.origin + path, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const early = await Promise.race([response, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1000); })]);
      assert.ok(early, `${path} waited for navigation badges`);
      assert.equal(early.status, 200);
      assert.equal(early.headers.get("Cache-Control"), "private, no-store");
      assert.equal(early.headers.get("X-Accel-Buffering"), "no");
      const first = await early.body!.getReader().read();
      assert.match(new TextDecoder().decode(first.value), /内容诊断|routes\/admin\/content/);
    } finally {
      clearTimeout(timer);
      resumeBadges();
      await response;
    }
  }
});

test("admin streaming still verifies identity before returning the page", async () => {
  signedIn = false;
  try {
    const res = await fetch(web.origin + "/admin/content", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("Location")!, /\/api\/auth\/login/);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  } finally { signedIn = true; }
});

test("both admin navigations render before badges and update them after arriving", async () => {
  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      badge = 7;
      await page.goto(web.origin + "/admin/sources");
      const sources = page.locator('nav a[href="/admin/sources"]').filter({ visible: true });
      await expect(sources).toHaveText("信源7");
      badge = 19;
      holdBadges();
      await page.getByRole("link", { name: "内容诊断", exact: true }).filter({ visible: true }).click();
      await expect(page.getByRole("heading", { name: "内容诊断", exact: true })).toBeVisible({ timeout: 1000 });
      resumeBadges();
      await expect(sources).toHaveText("信源19");
      badgeFailure = true;
      await sources.click();
      await expect(page.getByRole("heading", { name: "信源", exact: true })).toBeVisible();
      await expect(sources).toHaveText("信源");
    } finally {
      badgeFailure = false;
      resumeBadges();
      await context.close();
    }
  }
});

test("hovering private navigation does not repeat the page's reads before clicking", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(web.origin + "/admin/content");
    reads.length = 0;
    const sources = page.locator('nav a[href="/admin/sources"]').filter({ visible: true });
    await sources.hover();
    await page.waitForTimeout(250); // Intent prefetch starts after the router's hover delay.
    assert.deepEqual(reads, []);
    await sources.click();
    await expect(page.getByRole("heading", { name: "信源", exact: true })).toBeVisible();
    assert.deepEqual([...reads].sort(), ["/api/admin/me", "/api/admin/nav-counts", "/api/admin/sources"].sort());
  } finally { await page.close(); }
});

test("admin numeric formatting keeps existing missing-value and rounding behavior", () => {
  const values = [null, undefined, "", "bad", NaN, Infinity, -Infinity, -0, -1234567.891, 0, 0.0001, 9.995, 10, 1234567.891, "1234.50"];
  for (const value of values) {
    for (const digits of [0, 1, 2, 4]) {
      const v = Number(value);
      const expected = value == null || value === "" || !Number.isFinite(v) ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
      assert.equal(num(value, digits), expected);
    }
    for (const currency of ["CNY", "USD"]) {
      const v = Number(value);
      const expected = value == null ? "—" : `${currency === "USD" ? "$" : "¥"}${v.toLocaleString("zh-CN", { maximumFractionDigits: v < 10 ? 3 : 2, minimumFractionDigits: 2 })}`;
      assert.equal(money(value, currency), expected);
    }
  }
});
