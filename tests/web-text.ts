import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { webFiles, type Violation } from "./source-checks.ts";

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** Web code with no English edition, and why. Everything else a reader can reach in English is checked. */
export const CHINESE_ONLY: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^apps\/web\/app\/(?:routes\/admin(?:\/|-login\.tsx)|features\/admin\/)/, why: "the back office is for the owner only" },
  { pattern: /^apps\/web\/app\/routes\/(?:terms|privacy)\.tsx$/, why: "the terms and the privacy notice stay as they are; English pages link to them (2026-11-24)" },
  { pattern: /^modules\/free-tokens\/web/, why: "Token 羊毛 lists offers for readers in China (2026-11-24)" },
  { pattern: /^modules\/codex-reset\/web\/agent\.tsx$/, why: "the module’s machine-readable answers are in Chinese" },
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

function fileTextViolations(source: string): Violation[] {
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
  for (const file of webFiles(/\.tsx?$/)) {
    if (CHINESE_ONLY.some(({ pattern }) => pattern.test(file))) continue;
    const hits = fileTextViolations(readFileSync(new URL("../" + file, import.meta.url), "utf8"));
    if (hits.length) result.set(file, hits);
  }
  return result;
}

const ROUTER_LINK_EXPORTS = new Set(["Link", "NavLink", "useNavigate"]);

export function fileRouterLinkViolations(source: string): Violation[] {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: false }) as unknown as Node;
  const body = ((ast.program as Node).body as Node[]);
  const hits: Violation[] = [];
  const namespaces = new Set<string>();
  for (const stmt of body) {
    if (stmt.type !== "ImportDeclaration" || stmt.importKind === "type" || (stmt.source as Node).value !== "react-router") continue;
    const names: string[] = [];
    for (const spec of stmt.specifiers as Node[]) {
      if (spec.importKind === "type") continue;
      if (spec.type === "ImportSpecifier") {
        const imported = spec.imported as Node;
        const name = imported.type === "Identifier" ? (imported.name as string) : (imported.value as string);
        if (ROUTER_LINK_EXPORTS.has(name)) names.push(name);
      } else if (spec.type === "ImportNamespaceSpecifier" || spec.type === "ImportDefaultSpecifier") {
        namespaces.add((spec.local as Node).name as string);
      }
    }
    if (names.length) hits.push({ line: stmt.loc?.start.line ?? 0, fix: `${names.join("、")} 从 lib/link 取：它让英文页上的链接留在 /en` });
  }
  if (namespaces.size > 0) {
    const visit = (node: Node) => {
      if (node.type === "MemberExpression" && (node.object as Node).type === "Identifier" && namespaces.has((node.object as Node).name as string)) {
        const prop = node.property as Node;
        const name = !node.computed && prop.type === "Identifier" ? (prop.name as string)
          : node.computed && prop.type === "StringLiteral" ? (prop.value as string)
          : null;
        if (name && ROUTER_LINK_EXPORTS.has(name)) {
          hits.push({ line: node.loc?.start.line ?? 0, fix: `${name} 从 lib/link 取：它让英文页上的链接留在 /en` });
        }
      } else if (node.type === "JSXMemberExpression" && (node.object as Node).type === "JSXIdentifier" && namespaces.has((node.object as Node).name as string)) {
        const prop = node.property as Node;
        if (prop.type === "JSXIdentifier" && ROUTER_LINK_EXPORTS.has(prop.name as string)) {
          hits.push({ line: node.loc?.start.line ?? 0, fix: `${prop.name as string} 从 lib/link 取：它让英文页上的链接留在 /en` });
        }
      } else if (node.type === "VariableDeclarator" && (node.init as Node | null)?.type === "Identifier" && namespaces.has((node.init as Node).name as string) && (node.id as Node).type === "ObjectPattern") {
        const names: string[] = [];
        for (const prop of ((node.id as Node).properties as Node[])) {
          if (prop.type !== "ObjectProperty") continue;
          const key = prop.key as Node;
          const name = !prop.computed && key.type === "Identifier" ? (key.name as string) : key.type === "StringLiteral" ? (key.value as string) : null;
          if (name && ROUTER_LINK_EXPORTS.has(name)) names.push(name);
        }
        if (names.length) hits.push({ line: node.loc?.start.line ?? 0, fix: `${names.join("、")} 从 lib/link 取：它让英文页上的链接留在 /en` });
      }
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments")) continue;
        const value = node[key];
        if (Array.isArray(value)) { for (const v of value) if (v && typeof v === "object" && typeof (v as Node).type === "string") visit(v as Node); }
        else if (value && typeof value === "object" && typeof (value as Node).type === "string") visit(value as Node);
      }
    };
    visit(ast);
  }
  return hits;
}

/** Link, NavLink and useNavigate taken from react-router instead of lib/link.tsx (which keeps the page's language). */
export function routerLinkViolations(): Map<string, Violation[]> {
  const result = new Map<string, Violation[]>();
  for (const file of webFiles(/\.tsx?$/)) {
    if (file === "apps/web/app/lib/link.tsx") continue;
    const hits = fileRouterLinkViolations(readFileSync(new URL("../" + file, import.meta.url), "utf8"));
    if (hits.length) result.set(file, hits);
  }
  return result;
}
