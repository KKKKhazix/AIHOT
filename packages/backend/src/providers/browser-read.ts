// 2026-11-16：正文抽取的**本地浏览器**兜底（替代 Jina Reader）。
//
// 为什么不用 Jina：需要 API key、按次计费、请求要出境；本机已有 Chrome，直接
// `--dump-dom` 渲染一次拿最终 DOM，再交给 Readability 解析即可，零外部依赖、零费用。
// 代价是每篇多起一个 Chrome（约 1–2 秒），只在 direct fetch + Readability 失败时才走。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const BIN =
  process.env.BROWSER_READ_BIN ||
  ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p)) ||
  "/opt/google/chrome/chrome";

export async function browserHtml(url: string, timeoutMs = 25_000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      BIN,
      ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
        "--virtual-time-budget=8000", "--timeout=20000", "--dump-dom", url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(() => reject(new Error("browser read timeout")));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 8 * 1024 * 1024) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    });
    child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => {
      finish(() => {
        if (out.trim().length > 0) resolve(out);
        else reject(new Error(`browser read failed (exit ${code}): ${err.slice(0, 200)}`));
      });
    });
  });
}
