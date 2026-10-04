// Check new migrations against the PR base; deployed SQL is immutable in both engine and module trees.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { FIRST_ONLINE_MIGRATION, migrationPlan } from "./migration-safety.ts";

const isMigration = (file: string) => /^(database\/migrations|modules\/[^/]+\/migrations)\/[^/]+\.sql$/.test(file);

export function checkMigrations(root: string, base: string): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const before = new Set(git("ls-tree", "-r", "--name-only", base).split("\n").filter(isMigration));
  const current = git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter((file) => isMigration(file) && existsSync(path.join(root, file)));
  const problems: string[] = [];
  for (const file of before) {
    if (!existsSync(path.join(root, file)) || readFileSync(path.join(root, file), "utf8") !== git("show", `${base}:${file}`)) problems.push(`${file}: deployed migrations are immutable; add a new migration`);
  }
  const names = new Set<string>();
  for (const file of current) {
    const name = path.basename(file);
    if (names.has(name)) problems.push(`${file}: two migrations are named ${name}`);
    names.add(name);
    if (before.has(file)) continue;
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || Number(name.slice(0, 4)) < FIRST_ONLINE_MIGRATION) {
      problems.push(`${file}: new migrations start at ${String(FIRST_ONLINE_MIGRATION).padStart(4, "0")} and use NNNN_name.sql`);
      continue;
    }
    try { migrationPlan(readFileSync(path.join(root, file), "utf8")); }
    catch (error) { problems.push(`${file}: ${(error as Error).message}`); }
  }
  return problems;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { base: { type: "string", default: "HEAD" } } });
  const problems = checkMigrations(path.resolve(import.meta.dirname, ".."), values.base!);
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
  else console.log("migration history and online safety checked");
}
