// 在隔离行业配置中构建并运行生产 SSR，逐字检查报告副题。
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import type { ReportDetail, ReportKind } from "@aihot/contracts/site";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../../..");
const keys: Record<ReportKind, string> = { daily: "2026-09-29", weekly: "2026-W39", monthly: "2026-09" };
const authoredTitle = "AI remains in authored news";
const cases: Array<{ subject: string; expected: Record<ReportKind, string> }> = [
  { subject: "AI", expected: { daily: "AI · 每日要闻", weekly: "AI · 每周综述", monthly: "AI · 每月盘点" } },
  { subject: "法律", expected: { daily: "法律 · 每日要闻", weekly: "法律 · 每周综述", monthly: "法律 · 每月盘点" } },
  { subject: "HR", expected: { daily: "HR · 每日要闻", weekly: "HR · 每周综述", monthly: "HR · 每月盘点" } },
];

function reportOf(kind: ReportKind): ReportDetail & { issueNumber: number } {
  return {
    kind, key: keys[kind], issueNumber: 1, title: "Synthetic report",
    windowStart: "2026-09-01T00:00:00Z", windowEnd: "2026-09-30T00:00:00Z",
    generatedAt: "2026-09-30T00:00:00Z", revision: 1,
    lead: { title: authoredTitle, leadParagraph: "Preserve authored AI facts" },
    overview: null, highlights: [], sections: [], stories: [], cover: null,
    flashes: [{
      itemId: "motto-test", title: "Synthetic news", summary: "Synthetic summary", sourceName: "Source",
      sourceUrl: "https://example.org/original", sourceId: "source", sourceIconUrl: null, firstParty: true,
      role: null, storyPublicId: null, publishedAt: "2026-09-29T00:00:00Z", available: true,
    }],
    metrics: {}, readingMinutes: 1, prev: null, next: null,
  };
}

// 构建与服务器仅继承执行路径；不读取用户凭据或环境文件。
function fixtureEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: root, NODE_ENV: "production",
    npm_config_offline: "true", npm_config_update_notifier: "false",
    SITE_URL: "http://127.0.0.1:3000", API_BASE_URL: "http://127.0.0.1:9",
    WEB_HOST: "127.0.0.1", WEB_PORT: "0", TRUST_PROXY: "false",
    COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_OPS_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false", AIHOT_CREDENTIALS_DIR: path.join(root, "no-credentials"),
  };
}

async function subjectFixture(subject: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aihot-report-motto-"));
  try {
    for (const file of ["package.json", "tsconfig.base.json"]) await cp(path.join(ROOT, file), path.join(root, file));
    for (const dir of ["apps/web", "packages/contracts", "industry"]) {
      await cp(path.join(ROOT, dir), path.join(root, dir), {
        recursive: true,
        filter: source => !["node_modules", "build", ".react-router", "tests"].includes(path.basename(source)) && !path.basename(source).startsWith(".env"),
      });
    }
    await mkdir(path.join(root, "node_modules/@aihot"), { recursive: true });
    for (const name of await readdir(path.join(ROOT, "node_modules"))) {
      if (name !== "@aihot") await symlink(path.join(ROOT, "node_modules", name), path.join(root, "node_modules", name), "dir");
    }
    await symlink(path.join(root, "industry"), path.join(root, "node_modules/@aihot/industry"), "dir");
    await symlink(path.join(root, "packages/contracts"), path.join(root, "node_modules/@aihot/contracts"), "dir");
    const site = path.join(root, "industry/site.ts");
    const source = await readFile(site, "utf8");
    const subjectPattern = /(\bsubject:\s*)(["'])(.*?)\2/g;
    assert.equal([...source.matchAll(subjectPattern)].length, 1, "只替换隔离配置中的唯一行业词");
    await writeFile(site, source.replace(subjectPattern, (_match, prefix: string) => `${prefix}${JSON.stringify(subject)}`));
    await run("npm", ["run", "build", "-w", "@aihot/web"], {
      cwd: root, env: fixtureEnv(root), maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
    });
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function startWeb(root: string, apiUrl: string): Promise<{ web: ChildProcess; origin: string }> {
  const web = spawn(process.execPath, [path.join(root, "apps/web/server.ts")], {
    cwd: root, env: { ...fixtureEnv(root), API_BASE_URL: apiUrl }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`网页启动超时：${logs}`)), 15_000);
      web.on("error", error => { clearTimeout(timer); reject(error); });
      web.on("exit", () => { clearTimeout(timer); reject(new Error(`网页进程已退出：${logs}`)); });
      web.stderr!.on("data", chunk => { logs += String(chunk); });
      web.stdout!.on("data", chunk => {
        logs += String(chunk);
        const match = logs.match(/"msg":"web started","port":(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
    });
    return { web, origin: `http://127.0.0.1:${port}` };
  } catch (error) {
    if (web.exitCode === null) web.kill("SIGTERM");
    throw error;
  }
}

for (const { subject, expected } of cases) test(`报告副题跟随 ${subject}`, { timeout: 150_000 }, async t => {
  const root = await subjectFixture(subject);
  t.diagnostic(`${subject} 隔离生产构建完成`);
  const api = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-09-30T00:00" }));
    const match = /^\/api\/site\/reports\/(daily|weekly|monthly)\/latest-page$/.exec(url.pathname);
    if (match) {
      const kind = match[1] as ReportKind;
      return res.end(JSON.stringify({ index: [{ key: keys[kind] }], report: reportOf(kind) }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "not_found" }));
  });
  let web: ChildProcess | undefined;
  try {
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const started = await startWeb(root, `http://127.0.0.1:${(api.address() as AddressInfo).port}`);
    web = started.web;
    for (const kind of ["daily", "weekly", "monthly"] as const) await t.test(kind, async () => {
      const response = await fetch(`${started.origin}/${kind}`, { signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200);
      const { document } = parseHTML(await response.text());
      assert.equal(document.querySelector('[aria-label="头版"] h2')?.textContent, authoredTitle);
      const subtitles = document.querySelectorAll("article > header > div:first-child > span:nth-child(2)");
      assert.equal(subtitles.length, 1, "每期报头只有一条副题");
      assert.equal(subtitles[0]!.textContent, expected[kind]);
    });
  } finally {
    if (web && web.exitCode === null) { web.kill("SIGTERM"); await once(web, "exit"); }
    api.closeAllConnections();
    await new Promise<void>(resolve => api.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
