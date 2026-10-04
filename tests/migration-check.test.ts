// A pull request cannot change deployed history or hide an unsafe migration by naming it as history.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkMigrations } from "../scripts/check-migrations.ts";

const root = mkdtempSync(path.join(tmpdir(), "migration-git-"));
after(() => rmSync(root, { recursive: true, force: true }));
const write = (file: string, text: string) => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
};
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "Test");
write("database/migrations/0001_history.sql", "UPDATE old_table SET done = true;");
git("add", ".");
git("commit", "-qm", "history");

test("unchanged history is accepted, but edits and deletions fail", () => {
  assert.deepEqual(checkMigrations(root, "HEAD"), []);
  write("database/migrations/0001_history.sql", "SELECT 1;");
  assert.match(checkMigrations(root, "HEAD").join("\n"), /immutable/);
  rmSync(path.join(root, "database/migrations/0001_history.sql"));
  assert.match(checkMigrations(root, "HEAD").join("\n"), /immutable/);
  git("restore", ".");
});

test("new module migrations are checked even when untracked or named below the cutoff", () => {
  const file = "modules/example/migrations/0002_hidden.sql";
  write(file, "CREATE TABLE example (id int);");
  assert.match(checkMigrations(root, "HEAD").join("\n"), /0055/);
  rmSync(path.join(root, file));
  write("modules/example/migrations/0055_unsafe.sql", "UPDATE old_table SET done = false;");
  assert.match(checkMigrations(root, "HEAD").join("\n"), /0055_unsafe/);
  rmSync(path.join(root, "modules/example/migrations/0055_unsafe.sql"));
  write("modules/example/migrations/0055_safe.sql", "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (id);");
  assert.deepEqual(checkMigrations(root, "HEAD"), []);
});
