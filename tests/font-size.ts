import { readFileSync } from "node:fs";
import { sourceFiles, type Violation } from "./source-checks.ts";

const css = readFileSync(new URL("../apps/web/app/app.css", import.meta.url), "utf8");
const scale = new Map([...css.matchAll(/--(text-ui-[\w-]+):\s*([\d.]+)px;/g)].map(m => [m[2]!, m[1]!]));
// Tailwind arbitrary sizes (including responsive clamp), CSS, inline styles and literal SVG text sizes.
const px = String.raw`\d*\.?\d+px`;
const sized = String.raw`(?:${px}|(?:clamp|min|max|calc)\([^;{}\]]*?\dpx[^;{}\]]*\))`;
const writtenSize = new RegExp([
  String.raw`(?<![\w-])text-\[(?:length:)?${sized}\]`,
  String.raw`(?<![\w-])font\s*:\s*(?:[\w.%()-]+\s+)*?${sized}(?=[\s/;}]|$)`,
  String.raw`\bfont-size\s*:\s*${sized}`,
  String.raw`\bfontSize\s*(?::\s*|=\s*\{?\s*)(?:["']\d*\.?\d+(?:px)?["']|\d*\.?\d+(?=\s*[,}]))`,
].join("|"), "g");

export function fontSizeViolations() {
  const result = new Map<string, Violation[]>();
  for (const file of sourceFiles("apps/web", "modules/*/web.*", "modules/*/web/**", "site")) {
    if (!/\.(?:[jt]sx?|css)$/.test(file) || /\/(?:tests?|__tests__)\//.test(file)) continue;
    const hits: Violation[] = [];
    const withoutComments = readFileSync(new URL("../" + file, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, " "));
    const source = file.endsWith(".css") ? withoutComments : withoutComments.split("\n")
      .map(line => line.replace(/(^|\s)\/\/.*$/, "")).join("\n");
    for (const match of source.matchAll(writtenSize)) {
      const literal = match[0];
      const line = source.slice(0, match.index).split("\n").length;
      const token = scale.get(literal.match(/([\d.]+)px/)?.[1] ?? literal.match(/[\d.]+/)?.[0] ?? "");
      const use = token && !literal.includes("(")
        ? `用 ${token}（样式表和内联样式用 var(--${token})）`
        : "使用 app.css 的 --text-ui-* 字号；现有尺寸没有对应项时先在 @theme 定义等值的字号，再引用它";
      hits.push({ line, fix: `${literal} 写死了字号。请${use}，字号统一定义在 apps/web/app/app.css` });
    }
    result.set(file, hits);
  }
  return result;
}
