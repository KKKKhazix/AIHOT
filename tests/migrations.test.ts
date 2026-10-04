// Exercise migration failures against PostgreSQL: bounded locks, atomic bookkeeping, and invalid indexes.
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import postgres from "postgres";
import { runMigrations } from "../scripts/migrate.ts";

const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const other = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const roots: string[] = [];
after(async () => { await db.end(); await other.end(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "migrations-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

test("unsafe later files and duplicate module names fail before any change", async () => {
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9000_first.sql": "CREATE TABLE migration_never_created (id int);",
    "modules/example/migrations/9001_unsafe.sql": "UPDATE articles SET title = 'bad';",
  })), /9001_unsafe/);
  assert.equal((await db`SELECT to_regclass('migration_never_created') AS name`)[0].name, null);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9000_duplicate.sql": "CREATE TABLE migration_never_created (id int);",
    "modules/example/migrations/9000_duplicate.sql": "CREATE TABLE another_never_created (id int);",
  })), /two migrations/);
});

test("an interrupted historical multi-statement transaction never commits its schema or ledger entry", async () => {
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/0051_atomic.sql": "CREATE TABLE migration_rolled_back (id int); ALTER TABLE migration_missing ADD COLUMN flag text;",
  })), /0051_atomic/);
  assert.equal((await db`SELECT to_regclass('migration_rolled_back') AS name`)[0].name, null);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name = '0051_atomic.sql'`).length, 0);
});

test("a busy table aborts the migration promptly and leaves the serving schema alone", async () => {
  await db`CREATE TABLE migration_locked (id int)`;
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const blocker = other.begin(async (tx) => {
    await tx`LOCK TABLE migration_locked IN ACCESS SHARE MODE`;
    acquired();
    await hold;
  });
  await ready;
  const start = Date.now();
  try {
    await assert.rejects(runMigrations(db, fixture({
      "database/migrations/9003_lock.sql": "ALTER TABLE migration_locked ADD COLUMN flag text;",
    })), /9003_lock.*lock timeout/s);
    assert.ok(Date.now() - start < 4000, "DDL must not queue behind a long read for the HTTP timeout");
  } finally { release(); await blocker; }
  assert.equal((await db`SELECT 1 FROM information_schema.columns WHERE table_name = 'migration_locked' AND column_name = 'flag'`).length, 0);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name = '9003_lock.sql'`).length, 0);
});

test("concurrent module indexes apply and resume safely when only bookkeeping was interrupted", async () => {
  await db`CREATE TABLE migration_indexed (id int)`;
  await db`INSERT INTO migration_indexed SELECT generate_series(1, 10000)`;
  await db`CREATE INDEX CONCURRENTLY migration_idx ON migration_indexed (id)`;
  const root = fixture({
    "modules/example/migrations/9004_index.sql": "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_idx ON migration_indexed (id);",
    "database/migrations/9005_column.sql": "ALTER TABLE migration_indexed ADD COLUMN flag boolean NOT NULL DEFAULT false;",
  });
  assert.equal(await runMigrations(db, root), 2);
  assert.equal(await runMigrations(db, root), 0);
  assert.equal((await db`SELECT indisvalid FROM pg_index WHERE indexrelid = 'migration_idx'::regclass`)[0].indisvalid, true);
  assert.equal((await db`SELECT flag FROM migration_indexed LIMIT 1`)[0].flag, false);
});

test("IF NOT EXISTS must not turn an invalid or wrong-table index into a successful migration", async () => {
  await db`CREATE TABLE migration_invalid (id int)`;
  await db`INSERT INTO migration_invalid VALUES (1), (1)`;
  await assert.rejects(db`CREATE UNIQUE INDEX CONCURRENTLY migration_invalid_idx ON migration_invalid (id)`);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9006_invalid.sql": "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS migration_invalid_idx ON migration_invalid (id);",
  })), /invalid.*DROP INDEX CONCURRENTLY/s);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9007_wrong_table.sql": "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_idx ON migration_invalid (id);",
  })), /different table/);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name IN ('9006_invalid.sql', '9007_wrong_table.sql')`).length, 0);
});

test("same-table indexes must match keys, sort, predicate, included columns and uniqueness before resuming", async () => {
  await db`CREATE TABLE migration_shape (removed int, id int, title text, active boolean)`;
  await db`ALTER TABLE migration_shape DROP COLUMN removed`;
  await db`CREATE INDEX CONCURRENTLY migration_shape_idx ON migration_shape (lower(title) DESC, id) INCLUDE (active) WHERE active`;
  const variants = [
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_shape_idx ON migration_shape (id)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_shape_idx ON migration_shape (lower(title), id) INCLUDE (active) WHERE active",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_shape_idx ON migration_shape (lower(title) DESC, id) INCLUDE (active) WHERE NOT active",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_shape_idx ON migration_shape (lower(title) DESC, id) WHERE active",
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS migration_shape_idx ON migration_shape (lower(title) DESC, id) INCLUDE (active) WHERE active",
  ];
  for (const [i, text] of variants.entries()) {
    await assert.rejects(runMigrations(db, fixture({ [`database/migrations/901${i}_shape.sql`]: text })), /different definition/);
  }
  assert.equal(await runMigrations(db, fixture({
    "database/migrations/9020_shape.sql": "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_shape_idx ON migration_shape (lower(title) DESC, id) INCLUDE (active) WHERE active;",
  })), 1);
  assert.equal((await db`SELECT 1 FROM pg_class WHERE relname LIKE 'migration_expected_%' AND relnamespace = pg_my_temp_schema()`).length, 0);
});

test("release statistics fix correlated selection estimates and allow ordered reads without sorting every item", async () => {
  await db`CREATE TABLE migration_release (id int PRIMARY KEY, visibility text NOT NULL, selected boolean NOT NULL, seat boolean NOT NULL, visible_after timestamptz, published_at timestamptz NOT NULL, body text)`;
  await db`INSERT INTO migration_release SELECT i, 'public', i<=4000, true,
    CASE WHEN i<=3900 THEN '2026-09-28'::timestamptz WHEN i<=4000 THEN '2026-09-29'::timestamptz + i*interval '1 minute' ELSE NULL END,
    '2026-01-01'::timestamptz + ((i*17)%40000)*interval '1 minute', repeat('x',256)
    FROM generate_series(1,40000) s(i) ORDER BY md5(i::text)`;
  await db`CREATE INDEX migration_release_gate_idx ON migration_release (visible_after) WHERE visibility='public' AND selected`;
  await db`CREATE INDEX migration_release_order_idx ON migration_release (published_at DESC,id DESC) WHERE visibility='public' AND selected AND seat`;
  await db`ANALYZE migration_release`;
  // A lower random-page cost models cached SSD-backed reads; it never leaves this isolated connection.
  await db`SET random_page_cost=1.1`;
  try {
    const explain = async () => (await db`EXPLAIN (FORMAT JSON) SELECT id FROM migration_release
      WHERE visibility='public' AND selected AND seat AND visible_after<=${new Date("2026-10-04T12:00:00Z")}
      ORDER BY published_at DESC,id DESC LIMIT 50`)[0]["QUERY PLAN"][0].Plan;
    const before = await explain();
    assert.equal(before.Plans[0]["Node Type"], "Sort", "independent column statistics underestimate the released selection");
    const root = fixture({
      "database/migrations/9030_statistics.sql": "CREATE STATISTICS migration_release_stats (mcv) ON visibility,selected,seat,visible_after FROM migration_release;",
      "database/migrations/9031_analyze.sql": "ANALYZE migration_release (visibility,selected,seat,visible_after);",
    });
    assert.equal(await runMigrations(db, root), 2);
    const after = await explain();
    assert.equal(after.Plans[0]["Index Name"], "migration_release_order_idx");
    assert.ok(after.Plans[0]["Plan Rows"] > 3000, "estimate should reflect the correlated rows, not multiply their marginal frequencies");
    assert.equal(await runMigrations(db, root), 0);
  } finally { await db`RESET random_page_cost`; }
});
