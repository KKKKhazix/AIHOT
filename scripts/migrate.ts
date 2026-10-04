// Applies engine and module SQL by file name. New online DDL is bounded; concurrent indexes and
// constraint validation run separately so earlier DDL cannot hold a strong lock during a table scan.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import { FIRST_ONLINE_MIGRATION, indexOnEmptyTable, migrationPlan, type MigrationPlan } from "./migration-safety.ts";

async function sameIndexDefinition(session: postgres.ReservedSql, oid: number, table: string, text: string): Promise<boolean> {
  await session`BEGIN`;
  try {
    await session.unsafe(`CREATE TEMP TABLE migration_expected_table (LIKE ${table}) ON COMMIT DROP`);
    await session.unsafe(indexOnEmptyTable(text));
    const [match] = await session<{ matches: boolean }[]>`
      SELECT a.indisunique = e.indisunique AND a.indnullsnotdistinct = e.indnullsnotdistinct
        AND a.indnkeyatts = e.indnkeyatts AND ac.relam = ec.relam
        AND a.indclass = e.indclass AND a.indcollation = e.indcollation AND a.indoption = e.indoption
        AND ARRAY(SELECT pg_get_indexdef(a.indexrelid, n, false) FROM generate_series(1, a.indnatts) n)
          = ARRAY(SELECT pg_get_indexdef(e.indexrelid, n, false) FROM generate_series(1, e.indnatts) n)
        AND pg_get_expr(a.indpred, a.indrelid) IS NOT DISTINCT FROM pg_get_expr(e.indpred, e.indrelid) AS matches
      FROM pg_index a JOIN pg_class ac ON ac.oid = a.indexrelid
      CROSS JOIN pg_index e JOIN pg_class ec ON ec.oid = e.indexrelid
      WHERE a.indexrelid = ${oid} AND e.indexrelid = 'pg_temp.migration_expected_index'::regclass`;
    await session`COMMIT`;
    return match.matches;
  } catch (error) { await session`ROLLBACK`; throw error; }
}

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
          // retry must verify the existing definition, not just trust IF NOT EXISTS and its name.
          const indexName = plan.index.startsWith('"') ? plan.index.slice(1, -1).replaceAll('""', '"') : plan.index.toLowerCase();
          const existing = await session`SELECT 1 FROM pg_class WHERE relname = ${indexName}
            AND relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass(${plan.table}))`;
          await session.unsafe(text);
          const [index] = await session<{ oid: number; indisvalid: boolean; same_table: boolean }[]>`
            SELECT c.oid, i.indisvalid, i.indrelid = to_regclass(${plan.table}) AS same_table
            FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = ${indexName}
              AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass(${plan.table}))`;
          if (!index?.indisvalid) throw new Error(`index ${plan.index} is missing or invalid; inspect it and DROP INDEX CONCURRENTLY before retrying`);
          if (!index.same_table) throw new Error(`index ${plan.index} belongs to a different table`);
          if (existing.length && !await sameIndexDefinition(session, index.oid, plan.table, text)) throw new Error(`index ${plan.index} has a different definition; inspect it before retrying`);
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
