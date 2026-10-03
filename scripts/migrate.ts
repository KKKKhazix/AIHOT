// Applies database/migrations/*.sql and each module's own (modules/<name>/migrations/*.sql) in the order of
// their file names, each in its own transaction. Safe to re-run.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const sqlFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).map((name) => ({ name, file: path.join(dir, name) })) : []);
const modules = path.join(REPO_ROOT, "modules");
const migrations = [
  ...sqlFiles(path.join(REPO_ROOT, "database/migrations")),
  ...(existsSync(modules) ? readdirSync(modules).flatMap((name) => sqlFiles(path.join(modules, name, "migrations"))) : []),
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
for (const [i, m] of migrations.entries()) {
  if (migrations[i + 1]?.name === m.name) throw new Error(`two migrations are named ${m.name}: ${m.file} and ${migrations[i + 1]!.file}`);
}

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));

let count = 0;
for (const { name, file } of migrations) {
  if (applied.has(name)) continue;
  const text = readFileSync(file, "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
  });
  console.log(`applied ${name}`);
  count += 1;
}
console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
await closeDb();
