import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { sourceFiles, type Violation } from "./source-checks.ts";

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** Web code with no English edition, and why. Everything else a reader can reach in English is checked. */
export const CHINESE_ONLY: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^apps\/web\/app\/(?:routes\/admin(?:\/|-login\.tsx)|features\/admin\/)/, why: "the back office is for the owner only" },
  { pattern: /^apps\/web\/app\/(?:routes\/changelog\.tsx|features\/changelog\/)/, why: "the changelog is written for Chinese readers (product decision 2026-11-24)" },
  { pattern: /^apps\/web\/app\/routes\/(?:terms|privacy)\.tsx$/, why: "the terms and the privacy notice stay as they are; English pages link to them (2026-11-24)" },
  { pattern: /^modules\/free-tokens\/web/, why: "Token 羊毛 lists offers for readers in China (2026-11-24)" },
  { pattern: /^modules\/codex-reset\/web/, why: "the reset tracker's English edition comes in the second batch (2026-11-24)" },
  { pattern: /^modules\/legacy\/web/, why: "the old domain's notices, migration and archived terms are for readers of the Chinese site; English pages leave them out" },
  { pattern: /^modules\/ops\/web\/expiry/, why: "an admin page" },
];

// Babel's AST, as far as this check reads it.
interface Node { type: string; loc?: { start: { line: number } }; [key: string]: unknown }

const calleeName = (callee: Node): string | null =>
  callee.type === "Identifier" ? (callee.name as string)
  : callee.type === "MemberExpression" && (callee.property as Node).type === "Identifier" ? ((callee.property as Node).name as string)
  : null;

/** Why Chinese at the end of `path` (the node and its ancestors, innermost last) is wrong, or null when it is fine. */
function verdict(path: Node[]): string | null {
  for (let i = path.length - 1; i > 0; i--) {
    const node = path[i]!;
    const parent = path[i - 1]!;
    if (parent.type === "TSLiteralType") return null;
    if (parent.type === "CallExpression" && parent.callee !== node) {
      const callee = calleeName(parent.callee as Node);
      if (callee === "zh") return null;
      if (callee === "t" || callee === "L") {
        const args = parent.arguments as Node[];
        if (args.indexOf(node) !== 0) return "英文参数里还有中文：第二个参数写英文";
        return args.length >= 2 ? null : "只有中文没有英文：补上第二个参数，写成 t(\"中文\", \"English\")";
      }
    }
  }
  return "这段中文没有配英文：写成 t(\"中文\", \"English\")（组件外的常量用 L(…)），只作数据用的中文标 zh(…)";
}

function textOf(node: Node): string | null {
  if (node.type === "StringLiteral" || node.type === "JSXText") return node.value as string;
  if (node.type === "TemplateElement") return ((node.value as { cooked: string | null; raw: string }).cooked ?? (node.value as { raw: string }).raw);
  return null;
}

export function fileTextViolations(file: string, source: string): Violation[] {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: false }) as unknown as Node;
  const hits: Violation[] = [];
  const path: Node[] = [];
  const visit = (node: Node) => {
    path.push(node);
    const text = textOf(node);
    if (text !== null && CJK.test(text)) {
      const fix = verdict(path);
      if (fix) hits.push({ line: node.loc?.start.line ?? 0, fix: `${fix}：${text.trim().slice(0, 40)}` });
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments")) continue;
      const value = node[key];
      if (Array.isArray(value)) { for (const v of value) if (v && typeof v === "object" && typeof (v as Node).type === "string") visit(v as Node); }
      else if (value && typeof value === "object" && typeof (value as Node).type === "string") visit(value as Node);
    }
    path.pop();
  };
  visit(ast);
  return hits;
}

export function webTextViolations(): Map<string, Violation[]> {
  const result = new Map<string, Violation[]>();
  for (const file of sourceFiles("apps/web/app", "modules/*/web.*", "modules/*/web/**")) {
    if (!/\.tsx?$/.test(file) || /\/(?:tests?|__tests__)\//.test(file) || file.endsWith(".d.ts")) continue;
    if (CHINESE_ONLY.some(({ pattern }) => pattern.test(file))) continue;
    const hits = fileTextViolations(file, readFileSync(new URL("../" + file, import.meta.url), "utf8"));
    if (hits.length) result.set(file, hits);
  }
  return result;
}

/** Link, NavLink and useNavigate taken from react-router instead of lib/link.tsx (which keeps the page's language). */
export function routerLinkViolations(): Map<string, Violation[]> {
  const result = new Map<string, Violation[]>();
  const IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']react-router["']/g;
  for (const file of sourceFiles("apps/web/app", "modules/*/web.*", "modules/*/web/**")) {
    if (!/\.tsx?$/.test(file) || file === "apps/web/app/lib/link.tsx" || /\/(?:tests?|__tests__)\//.test(file)) continue;
    const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    const hits: Violation[] = [];
    for (const m of source.matchAll(IMPORT)) {
      const names = m[1]!.split(",").map((s) => s.trim()).filter((s) => ["Link", "NavLink", "useNavigate"].includes(s));
      if (names.length) hits.push({ line: source.slice(0, m.index).split("\n").length, fix: `${names.join("、")} 从 lib/link 取：它让英文页上的链接留在 /en` });
    }
    if (hits.length) result.set(file, hits);
  }
  return result;
}
