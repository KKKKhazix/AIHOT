import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
export interface Violation { line: number; code: string; fix: string }

/** Each fingerprint admits one existing occurrence in that file. Moving the same line still works. */
export function checkSourceDebt(name: string, violations: Map<string, Violation[]>) {
  const files = [`tests/${name}-debt.json`, `ops/ci/${name}-debt.json`].filter(f => existsSync(path.join(root, f)));
  const baseline = new Map<string, string[]>();
  const problems: string[] = [];
  const ref = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8" });
  for (const file of files) {
    const budget: Record<string, string> = JSON.parse(readFileSync(path.join(root, file), "utf8"));
    // A PR may remove entries, including the last entry of an entire file. Adding a fingerprint to the list is not a fix.
    if (ref.status === 0) {
      const prior = spawnSync("git", ["show", `${ref.stdout.trim()}:${file}`], { cwd: root, encoding: "utf8" });
      if (prior.status === 0) {
        const old: Record<string, string> = JSON.parse(prior.stdout);
        for (const [source, hashes] of Object.entries(budget)) {
          const left = (old[source] ?? "").split(" ");
          for (const h of hashes.split(" ")) {
            const i = left.indexOf(h);
            if (i < 0) problems.push(`${file} 不能增加 ${source} 的欠账 ${h}；请修正新增写法`);
            else left.splice(i, 1);
          }
        }
      }
    }
    for (const [source, hashes] of Object.entries(budget)) baseline.set(source, hashes.split(" "));
  }
  for (const [file, hits] of violations) {
    const left = baseline.get(file) ?? [];
    for (const hit of hits) {
      const hash = createHash("sha256").update(hit.code.trim()).digest("hex").slice(0, 12);
      const i = left.indexOf(hash);
      if (i < 0) problems.push(`${file}:${hit.line} ${hit.fix} (${hash})`);
      else left.splice(i, 1);
    }
  }
  for (const [file, left] of baseline) {
    if (left.length) problems.push(`${file} 已消除 ${left.length} 处，请从 ${name}-debt.json 删除 ${left.join(" ")}`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
}

export function sourceFiles(...patterns: string[]): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...patterns],
    { cwd: root, encoding: "utf8" }).split("\0").filter(file => file && existsSync(path.join(root, file)));
}
