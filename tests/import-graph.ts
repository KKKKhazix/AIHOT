import { parse } from "@babel/parser";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "./source-checks.ts";

const root = path.resolve(import.meta.dirname, "..");
const code = /\.(?:tsx?|m?js)$/;

/** The web alias uses Vite's extension lookup. Other workspace packages use Node's package exports. */
export function workspaceImportPath(file: string, spec: string): string | undefined {
  if (spec.startsWith(".")) return path.posix.join(path.posix.dirname(file), spec);
  if (spec.startsWith("@aihot/web/")) return path.posix.join("apps/web/app", spec.slice("@aihot/web/".length));
  if (spec.startsWith("@aihot/")) return path.relative(root, fileURLToPath(import.meta.resolve(spec))).split(path.sep).join("/");
}

/** Static ES imports and re-exports load both files during initialization. A later import() does not. */
export function staticImportGraph() {
  const files = sourceFiles("apps", "packages", "modules", "site", "industry", "clients", "scripts", "ops")
    .filter(file => code.test(file) && !/(?:^|\/)tests?\/|\.test\.|\.d\.ts$/.test(file));
  const graph = new Map(files.map(file => [file, new Set<string>()]));
  for (const [file, imports] of graph) {
    const program = parse(readFileSync(path.join(root, file), "utf8"), {
      sourceType: "unambiguous", plugins: ["typescript", ...(file.endsWith(".tsx") ? ["jsx" as const] : []), "importAttributes"],
    }).program;
    for (const node of program.body) {
      if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration" && node.type !== "ExportAllDeclaration") continue;
      if (node.type === "ImportDeclaration" ? node.importKind === "type" : node.exportKind === "type") continue;
      const spec = node.source?.value;
      if (!spec || /\?(?:raw|url)$/.test(spec)) continue;
      const name = workspaceImportPath(file, spec.split("?")[0]!);
      if (name === undefined) continue;
      const target = [name, name + ".ts", name + ".tsx", name + "/index.ts", name + "/index.tsx"].find(f => graph.has(f));
      if (target) imports.add(target);
      else if (code.test(name) || !existsSync(path.join(root, name))) throw Error(`无法解析本地依赖：${file} → ${spec}`);
    }
  }
  return graph;
}

/** Report a path back to each ancestor encountered by depth-first traversal. */
export function importCycles(graph: Map<string, Set<string>>) {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const found: string[][] = [];
  function visit(file: string) {
    if (stack.has(file)) {
      const chain = [...stack];
      found.push([...chain.slice(chain.indexOf(file)), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    stack.add(file);
    for (const dependency of graph.get(file)!) visit(dependency);
    stack.delete(file);
  }
  for (const file of graph.keys()) visit(file);
  return found;
}

// Inspect the same graph used by CI without storing a second copy of the dependency map.
if (import.meta.main) console.log(JSON.stringify(Object.fromEntries([...staticImportGraph()].map(([file, deps]) => [file, [...deps]])), null, 2));
