import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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
