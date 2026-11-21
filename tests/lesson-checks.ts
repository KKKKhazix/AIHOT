import { readFileSync } from "node:fs";
import { sourceFiles, type Violation } from "./source-checks.ts";

const root = new URL("../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");

/** Only a URL built from the incoming request identifies a route. Links to other sites can read their own pathname. */
export function rawLoaderPaths(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles("apps/web/app", "modules/*/web.*", "modules/*/web/**")) {
    if (!/\.tsx?$/.test(file) || file.includes("/tests/")) continue;
    const text = read(file);
    if (!text.includes("pathname") || !text.includes("loader")) continue;
    // Only the exported loader's declaration. Other exports in the same route (meta, components and
    // cache keys) receive the document URL, and logging helpers can retain the literal request path.
    for (const fn of text.matchAll(/^export\s+(?:(?:async\s+)?function\s+loader\b|const\s+loader\s*=)[\s\S]*?(?=^export\b|^}\s*(?:;|$)|(?![\s\S]))/gm)) {
      const body = fn[0];
      const url = String.raw`new\s+URL\(\s*\w+\.url\s*\)`;
      const names = [...body.matchAll(new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*${url}`, "g"))].map(m => m[1]!);
      const receivers = [url, ...names.map(n => String.raw`\b${n}\b`)].join("|");
      const raw = new RegExp(String.raw`(?:${receivers})\s*(?:\.\s*pathname\b|\[\s*["']pathname["']\s*\])|\{[^{};]*\bpathname\b[^{};]*\}\s*=\s*(?:${receivers})`, "g");
      for (const match of body.matchAll(raw)) {
        const line = text.slice(0, fn.index + match.index).split("\n").length;
        found.push(`${file}:${line} 请用 pagePathname(request) 判断页面。整页请求和站内跳转的 .data 请求须选中同一页`);
      }
    }
  }
  return found;
}

/** Reader-visible state and scroll position are valid test targets. A CSS class or pixel delta is an implementation detail. */
export function presentationAssertions() {
  const found = new Map<string, Violation[]>();
  for (const file of sourceFiles("*test*", "*spec*").filter(f => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f))) {
    const hits: Violation[] = [];
    for (const [i, line] of read(file).split("\n").entries()) {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
      const cls = /\.toHaveClass\s*\(|\b(?:expect|assert(?:\.\w+)?)\s*\([^;]*?(?:\.classList\.contains\(|\.className\b|getAttribute\(["']class["']\))/.test(line);
      const pixels = /(?:\.toBeLessThan(?:OrEqual)?\(\s*\d|<=?\s*\d+\s*[,)])/.test(line)
        && /Math\.abs\([^;]*?(?:\.(?:top|bottom|left|right|width|height)\b|getBoundingClientRect\()/.test(line);
      if (cls || pixels) hits.push({ line: i + 1, fix: cls
        ? "请断言读者能看到的内容、状态或可执行的操作，移除对 CSS 类名的断言"
        : "请比较可见条目、顺序或能否操作，移除元素坐标只差几个像素的断言" });
    }
    found.set(file, hits);
  }
  return found;
}
