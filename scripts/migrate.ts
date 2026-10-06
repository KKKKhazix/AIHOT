// Applies engine and module SQL by file name. New online DDL is bounded; concurrent indexes and
// constraint validation run separately so earlier DDL cannot hold a strong lock during a table scan.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import { FIRST_ONLINE_MIGRATION, migrationPlan, type MigrationPlan } from "./migration-safety.ts";

export async function runMigrations(sql: postgres.Sql, root: string): Promise<number> {
  const sqlFiles = (dir: string) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).map((name) => ({ name, file: path.join(dir, name) })) : [];
  const modules = path.join(root, "modules");
  const migrations = [
    ...sqlFiles(path.join(root, "database/migrations")),
    ...(existsSync(modules) ? readdirSync(modules).flatMap((name) => sqlFiles(path.join(modules, name, "migrations"))) : []),
  ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const [i, migration] of migrations.entries()) {
    if (migrations[i + 1]?.name === migration.name) throw new Error(`two migrations are named ${migration.name}: ${migration.file} and ${migrations[i + 1].file}`);
  }
  // Validate the complete set before making any change; old files remain installable as history.
  const prepared = migrations.map((migration) => {
    const text = readFileSync(migration.file, "utf8");
    let plan: MigrationPlan = { kind: "transaction" };
    try { if (Number(migration.name.slice(0, 4)) >= FIRST_ONLINE_MIGRATION) plan = migrationPlan(text); }
    catch (error) { throw new Error(`${migration.name}: ${(error as Error).message}`, { cause: error }); }
    return { ...migration, text, plan };
  });
  const session = await sql.reserve();
  try {
    await session`SET lock_timeout = '1s'`;
    await session`SET statement_timeout = '10s'`;
    await session`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Set((await session<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name));
    let count = 0;
    for (const { name, text, plan } of prepared) {
      if (applied.has(name)) continue;
      const start = Date.now();
      try {
        await session`SELECT set_config('lock_timeout', ${plan.kind === "transaction" ? "1s" : "30s"}, false)`;
        await session`SELECT set_config('statement_timeout', ${plan.kind === "transaction" ? "10s" : "30min"}, false)`;
        if (plan.kind === "index") {
          // A concurrent build's internal transactions cannot be wrapped in our transaction. Its
          // retry must not trust IF NOT EXISTS: an interrupted build leaves an invalid index of that name.
          const indexName = plan.index.startsWith('"') ? plan.index.slice(1, -1).replaceAll('""', '"') : plan.index.toLowerCase();
          await session.unsafe(text);
          const [index] = await session<{ indisvalid: boolean; same_table: boolean }[]>`
            SELECT i.indisvalid, i.indrelid = to_regclass(${plan.table}) AS same_table
            FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = ${indexName}
              AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass(${plan.table}))`;
          if (!index?.indisvalid) throw new Error(`index ${plan.index} is missing or invalid; inspect it and DROP INDEX CONCURRENTLY before retrying`);
          if (!index.same_table) throw new Error(`index ${plan.index} belongs to a different table`);
          await session`INSERT INTO schema_migrations (name) VALUES (${name})`;
        } else {
          await session`BEGIN`;
          try {
            await session.unsafe(text);
            await session`INSERT INTO schema_migrations (name) VALUES (${name})`;
            await session`COMMIT`;
          } catch (error) {
            await session`ROLLBACK`;
            throw error;
          }
        }
      } catch (error) {
        throw new Error(`migration ${name} failed after ${Date.now() - start}ms: ${(error as Error).message}`, { cause: error });
      }
      console.log(`applied ${name} (${Date.now() - start}ms, ${plan.kind})`);
      count++;
    }
    console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
    return count;
  } finally {
    try { await session`RESET lock_timeout`; await session`RESET statement_timeout`; }
    finally { session.release(); }
  }
}

if (import.meta.main) {
  const { REPO_ROOT } = await import("@aihot/backend/config");
  const { closeDb, sql } = await import("@aihot/backend/db");
  try { await runMigrations(sql, REPO_ROOT); }
  finally { await closeDb(); }
}
