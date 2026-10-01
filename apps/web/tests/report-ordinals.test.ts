// 使用真实生产 SSR 服务与回环 API 夹具验证报头；不是浏览器截图或画布交互测试。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ReportDetail, ReportKind, ReportNavigationEntry } from "@aihot/contracts/site";
import { isoWeekLabel } from "@aihot/contracts/time";
import { issueNumber, periodGrid } from "../app/features/report/format.ts";

const kinds: ReportKind[] = ["daily", "weekly", "monthly"];
const keys = Object.fromEntries(kinds.map((kind) => [kind, Array.from({ length: 405 }, (_, i) => {
  if (kind === "monthly") return new Date(Date.UTC(2020, i, 1)).toISOString().slice(0, 7);
  const day = new Date(Date.UTC(2020, 0, 6 + i * (kind === "weekly" ? 7 : 1))).toISOString().slice(0, 10);
  return kind === "weekly" ? isoWeekLabel(day) : day;
})])) as Record<ReportKind, string[]>;
const index = (kind: ReportKind): ReportNavigationEntry[] => keys[kind].map((key, i) => ({ key, issueNumber: i + 1, title: `第${i + 1}期` })).reverse().slice(0, 400);
function report(kind: ReportKind, key: string): ReportDetail {
  return {
    kind, key, issueNumber: keys[kind].indexOf(key) + 1, title: "测试刊物", windowStart: "2020-01-01T00:00:00Z", windowEnd: "2020-01-02T00:00:00Z", generatedAt: "2020-01-02T00:00:00Z", revision: 1,
    lead: null, overview: null, highlights: [], sections: [], stories: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null,
  };
}
let web: ChildProcess;
let origin: string;
let logs = "";
const api = createServer((req, res) => {
  const path = new URL(req.url!, "http://api.local").pathname;
  res.setHeader("Content-Type", "application/json");
  if (path === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
  const match = /^\/api\/site\/reports\/(daily|weekly|monthly)\/(.+)$/.exec(path);
  if (match) {
    const kind = match[1] as ReportKind;
    const key = match[2]!;
    if (key === "latest-page") return res.end(JSON.stringify({ index: index(kind), report: report(kind, keys[kind].at(-1)!) }));
    if (key.startsWith("navigation/")) return res.end(JSON.stringify({ items: index(kind) }));
    if (keys[kind].includes(key)) return res.end(JSON.stringify(report(kind, key)));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});
before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "production", WEB_HOST: "127.0.0.1", WEB_PORT: "0", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
  });
});
after(async () => {
  if (web && web.exitCode === null) { web.kill("SIGTERM"); await once(web, "exit"); }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

function masthead(html: string): string {
  const header = /<header class="pt-5 lg:pt-0">([\s\S]*?)<\/header>/.exec(html);
  assert.ok(header, "the actual report masthead must be rendered");
  return header[1]!.replace(/<[^>]+>/g, "");
}

for (const kind of kinds) {
  test(`production SSR ${kind} masthead shows 405 instead of the navigation length`, async () => {
    const response = await fetch(`${origin}/${kind}`);
    assert.equal(response.status, 200, logs);
    const html = await response.text();
    const visible = masthead(html);
    assert.match(visible, /第\s*405\s*期/);
    assert.doesNotMatch(visible, /第\s*400\s*期/);
  });
  test(`production SSR ${kind} oldest detail retains its own first issue number`, async () => {
    const first = keys[kind][0]!;
    assert.ok(!index(kind).some((entry) => entry.key === first));
    const response = await fetch(`${origin}/${kind}/${first}`);
    assert.equal(response.status, 200, logs);
    const visible = masthead(await response.text());
    assert.match(visible, /第\s*1\s*期/);
  });
}


for (const kind of kinds) {
  test(`${kind} calendar keeps the current old issue number without inventing other old issues`, () => {
    const first = keys[kind][0]!;
    const grid = periodGrid(kind, first, index(kind), 1);
    const current = grid.cells.find((cell) => cell.key === first)!;
    assert.equal(current.state, "current");
    assert.match(current.label, /第 1 期/);
    assert.doesNotMatch(current.label, /未出刊/);
    const absent = grid.cells.find((cell) => cell.key === keys[kind][1])!;
    assert.equal(absent.state, "none");
    assert.match(absent.label, /未出刊/);
    assert.equal(issueNumber(index(kind), keys[kind].at(-1)!), 405);
    const refreshed = periodGrid(kind, first, [{ key: first, issueNumber: 9 }], 10);
    assert.match(refreshed.cells.find((cell) => cell.key === first)!.label, /第 10 期/, "current detail metadata wins over an older navigation snapshot");
  });
  test(`${kind} known entries without numbers stay published without length-based fallback`, () => {
    const current = keys[kind].at(-1)!;
    const previous = keys[kind].at(-2)!;
    const legacy = [{ key: current }, { key: previous }];
    assert.equal(issueNumber(legacy, current), null);
    const grid = periodGrid(kind, current, legacy);
    for (const key of [current, previous]) {
      const cell = grid.cells.find((entry) => entry.key === key)!;
      assert.match(cell.label, /已出刊/);
      assert.doesNotMatch(cell.label, /未出刊|第 \d+ 期/);
    }
    for (const n of [0, -1, NaN, 1.5]) assert.equal(issueNumber([{ key: current, issueNumber: n }], current), null);
  });
}
