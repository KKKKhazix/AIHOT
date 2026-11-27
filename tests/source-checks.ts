import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

const root = path.resolve(import.meta.dirname, "..");
export interface Violation { line: number; fix: string }

export function assertNoViolations(violations: Map<string, Violation[]>) {
  const problems = Array.from(violations).flatMap(([file, hits]) =>
    hits.map(hit => `${file}:${hit.line} ${hit.fix}`));
  assert.deepEqual(problems, [], problems.join("\n"));
}

export function sourceFiles(...patterns: string[]): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...patterns],
    { cwd: root, encoding: "utf8" }).split("\0").filter(file => file && existsSync(path.join(root, file)));
}

/** Reader-facing web files across the app, module web code and site TSX components (excluding tests and .d.ts). */
export function webFiles(kind = /\.tsx?$/): string[] {
  return sourceFiles("apps/web/app", "modules/*/web.*", "modules/*/web/**", "site/**/*.tsx")
    .filter((file) => kind.test(file) && !/\/(?:tests?|__tests__)\//.test(file) && !file.endsWith(".d.ts"));
}

/** Removes block and line comments while keeping line numbers intact for lightweight source checks. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));
}

const FUNCTION_NODES = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod",
]);

/** Finds calls to `callee` evaluated at module top level (outside any function/arrow/method body). */
export function topLevelCalls(source: string, callee: string): Violation[] {
  type Node = { type: string; loc?: { start: { line: number } }; [key: string]: unknown };
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: false }) as unknown as Node;
  const hits: Violation[] = [];
  const visit = (node: Node, insideFunction: boolean) => {
    if (node.type === "CallExpression" && !insideFunction) {
      const target = node.callee as Node;
      const name = target.type === "Identifier" ? target.name
        : target.type === "MemberExpression" && !target.computed && (target.property as Node).type === "Identifier" ? (target.property as Node).name
        : null;
      if (name === callee) hits.push({ line: node.loc?.start.line ?? 0, fix: `不要在模块顶层直接调用 ${callee}()` });
    }
    const nextInside = insideFunction || FUNCTION_NODES.has(node.type);
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments")) continue;
      const value = node[key];
      if (Array.isArray(value)) { for (const v of value) if (v && typeof v === "object" && typeof (v as Node).type === "string") visit(v as Node, nextInside); }
      else if (value && typeof value === "object" && typeof (value as Node).type === "string") visit(value as Node, nextInside);
    }
  };
  visit(ast, false);
  return hits;
}
