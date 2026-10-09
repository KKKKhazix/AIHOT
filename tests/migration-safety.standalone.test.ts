// Failure cases for online migrations: table scans under strong locks, unsafe retries, and hidden SQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationPlan } from "../scripts/migration-safety.ts";

test("online migrations reject writes, blocking indexes and table rewrites before execution", () => {
  for (const statement of [
    "UPDATE articles SET selected = true;",
    "WITH batch AS (SELECT id FROM articles LIMIT 100) UPDATE articles SET selected = true;",
    "DELETE FROM articles WHERE id = 'one';",
    "TRUNCATE articles;",
    "CREATE INDEX articles_idx ON articles (id);",
    "CREATE UNIQUE INDEX articles_idx ON articles (id);",
    "ALTER TABLE articles ADD COLUMN flag text CHECK (flag IN ('a', 'b'));",
    "ALTER TABLE articles ADD COLUMN receipt bigint REFERENCES receipts(id);",
    "ALTER TABLE articles ADD COLUMN flag text NOT NULL;",
    "ALTER TABLE articles ADD COLUMN flag double precision DEFAULT random();",
    "ALTER TABLE articles ADD COLUMN id bigserial;",
    "ALTER TABLE articles ADD COLUMN created_at timestamptz DEFAULT clock_timestamp();",
    "ALTER TABLE articles ALTER COLUMN id TYPE bigint;",
    "ALTER TABLE articles ADD CONSTRAINT key UNIQUE (id);",
    "ALTER TABLE articles ADD CONSTRAINT positive CHECK (id > 0);",
    "ALTER TABLE articles ADD COLUMN flag text, ADD CONSTRAINT positive CHECK (id > 0);",
    "CREATE TABLE clone AS SELECT * FROM articles;",
    "DO $$ BEGIN UPDATE articles SET selected = true; END $$;",
    "SELECT pg_sleep(60);",
    "SET lock_timeout = 0;",
    "BEGIN; ALTER TABLE articles ADD COLUMN flag text; COMMIT;",
  ]) assert.throws(() => migrationPlan(statement), statement);
});

test("online migrations permit metadata changes and split constraint validation", () => {
  for (const statement of [
    "CREATE TABLE example (id bigint PRIMARY KEY, body text NOT NULL);",
    "ALTER TABLE articles ADD COLUMN flag text;",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS selected boolean NOT NULL DEFAULT false;",
    "ALTER TABLE articles ADD COLUMN flag text DEFAULT 'pending' NOT NULL;",
    "ALTER TABLE articles ADD COLUMN tags text[] DEFAULT '{}'::text[];",
    "ALTER TABLE articles ADD CONSTRAINT positive CHECK (id > 0) NOT VALID;",
    "ALTER TABLE articles ADD CONSTRAINT owner FOREIGN KEY (source_id) REFERENCES sources(id) NOT VALID;",
    "ALTER TABLE articles ALTER COLUMN flag SET DEFAULT 'pending';",
    "ALTER TABLE articles ALTER COLUMN flag DROP DEFAULT;",
  ]) assert.equal(migrationPlan(statement).kind, "transaction", statement);
  assert.equal(migrationPlan("ALTER TABLE articles VALIDATE CONSTRAINT positive;").kind, "validation");
  assert.throws(() => migrationPlan("ALTER TABLE articles ADD COLUMN flag text; ALTER TABLE articles VALIDATE CONSTRAINT positive;"));
});

// Vacuum tuning must not disable cleanup, alter unrelated storage settings, evaluate expressions,
// escape the numeric bounds, repeat a parameter or bundle another table action/statement.
test("online vacuum tuning accepts only bounded insert and dead-tuple scale factors", () => {
  for (const statement of [
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_insert_scale_factor = 0.02);",
    "ALTER TABLE public.analytics_events SET (autovacuum_vacuum_scale_factor = 1);",
    'ALTER TABLE "public"."analytics_events" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);',
    "ALTER TABLE analytics_events SET (AUTOVACUUM_VACUUM_INSERT_SCALE_FACTOR = 0.02, AUTOVACUUM_VACUUM_SCALE_FACTOR = 1.0);",
  ]) assert.equal(migrationPlan(statement).kind, "transaction", statement);
  for (const statement of [
    "ALTER TABLE analytics_events SET (autovacuum_enabled = false);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_insert_threshold = -1);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_insert_scale_factor = 0);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = -0.02);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = 1.01);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = '0.02');",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = 0.01 + 0.01);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = 2e-2);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = NaN);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = 0.02, fillfactor = 50);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.03);",
    "ALTER TABLE analytics_events RESET (autovacuum_vacuum_scale_factor);",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = 0.02), ADD COLUMN flag text;",
    "ALTER TABLE analytics_events SET (autovacuum_vacuum_scale_factor = 0.02); SET lock_timeout = 0;",
    "ALTER SYSTEM SET autovacuum_vacuum_scale_factor = 0.02;",
  ]) assert.throws(() => migrationPlan(statement), statement);
});

// Dropping a table nothing uses: a dependent object must stop it (no CASCADE), and one statement may not
// lock several tables at once.
test("a table nothing uses can be dropped alone, never with its dependents", () => {
  assert.equal(migrationPlan("DROP TABLE IF EXISTS retired_example;").kind, "transaction");
  assert.equal(migrationPlan("-- retired\nDROP TABLE IF EXISTS public.retired_example;").kind, "transaction");
  for (const statement of [
    "DROP TABLE IF EXISTS retired_example CASCADE;",
    "DROP TABLE retired_example;",
    "DROP TABLE IF EXISTS retired_example, articles;",
    "DROP TABLE IF EXISTS retired_example; DROP TABLE IF EXISTS articles;",
    "DROP INDEX articles_idx;",
  ]) assert.throws(() => migrationPlan(statement), statement);
});

// Dropping a column or a constraint nothing uses: it must not take dependent objects along (CASCADE),
// bundle several drops or another action into one statement, or fail where it is already gone.
test("a column or a constraint nothing uses can be dropped alone, never with its dependents", () => {
  for (const statement of [
    "ALTER TABLE articles DROP COLUMN IF EXISTS flag;",
    "ALTER TABLE public.articles DROP COLUMN IF EXISTS flag;",
    "ALTER TABLE articles DROP CONSTRAINT IF EXISTS positive;",
  ]) assert.equal(migrationPlan(statement).kind, "transaction", statement);
  for (const statement of [
    "ALTER TABLE articles DROP COLUMN flag;",
    "ALTER TABLE articles DROP flag;",
    "ALTER TABLE articles DROP COLUMN IF EXISTS flag CASCADE;",
    "ALTER TABLE articles DROP COLUMN IF EXISTS flag RESTRICT;",
    "ALTER TABLE articles DROP COLUMN IF EXISTS flag, DROP COLUMN IF EXISTS note;",
    "ALTER TABLE articles DROP COLUMN IF EXISTS flag, ADD COLUMN note text;",
    "ALTER TABLE articles DROP COLUMN IF EXISTS flag; ALTER TABLE articles DROP COLUMN IF EXISTS note;",
    "ALTER TABLE articles DROP CONSTRAINT positive;",
    "ALTER TABLE articles DROP CONSTRAINT IF EXISTS positive CASCADE;",
  ]) assert.throws(() => migrationPlan(statement), statement);
});

test("concurrent indexes have one retriable statement per file, outside a transaction", () => {
  const plan = migrationPlan("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS article_idx ON public.articles (id) WHERE id IS NOT NULL;");
  assert.deepEqual(plan, { kind: "index", index: "article_idx", table: "public.articles" });
  assert.throws(() => migrationPlan("CREATE INDEX CONCURRENTLY article_idx ON articles (id);"));
  assert.throws(() => migrationPlan("CREATE INDEX CONCURRENTLY IF NOT EXISTS article_idx ON articles (id); ALTER TABLE articles ADD COLUMN flag text;"));
});

test("comments and string literals cannot disguise dangerous statements or split safe defaults", () => {
  assert.equal(migrationPlan("/* outer /* nested */ comment */ ALTER TABLE articles ADD COLUMN note text DEFAULT 'CHECK; -- it''s text'; -- UPDATE articles\n").kind, "transaction");
  assert.throws(() => migrationPlan("CREATE /* misleading */ INDEX article_idx ON articles (id);"));
  assert.throws(() => migrationPlan("ALTER TABLE articles ADD COLUMN note text DEFAULT 'safe'; UPDATE articles SET note = 'all';"));
  assert.throws(() => migrationPlan("ALTER TABLE articles ADD COLUMN note text /* unfinished"));
});

test("online DDL cannot accumulate strong table locks across several otherwise safe statements", () => {
  assert.throws(() => migrationPlan("ALTER TABLE articles ADD COLUMN flag text; ALTER TABLE publications ADD COLUMN flag text;"), /one statement/);
  assert.throws(() => migrationPlan("CREATE TABLE example (id int); ALTER TABLE articles ADD COLUMN flag text;"), /one statement/);
});

test("statistics maintenance names one table and its columns without skipping work or evaluating expressions", () => {
  assert.equal(migrationPlan("CREATE STATISTICS article_release_stats (mcv) ON visibility, selected, seat, visible_after FROM publications;").kind, "statistics");
  assert.equal(migrationPlan("ANALYZE public.publications (visibility, selected, seat, visible_after);").kind, "statistics");
  assert.equal(migrationPlan('CREATE STATISTICS "public"."release_stats" (MCV) ON "selected", "visible_after" FROM public.publications;').kind, "statistics");
  assert.equal(migrationPlan('ANALYZE "public"."publications" ("selected");').kind, "statistics");
  for (const statement of [
    "CREATE STATISTICS IF NOT EXISTS article_release_stats (mcv) ON selected, visible_after FROM publications;",
    "CREATE STATISTICS article_release_stats ON selected, visible_after FROM publications;",
    "CREATE STATISTICS article_release_stats (mcv) ON selected, (random()) FROM publications;",
    "CREATE STATISTICS article_release_stats (dependencies) ON selected, visible_after FROM publications;",
    "CREATE STATISTICS article_release_stats (mcv, ndistinct) ON selected, visible_after FROM publications;",
    "CREATE STATISTICS article_release_stats (mcv) ON selected FROM publications;",
    "CREATE STATISTICS article_release_stats (mcv) ON selected, lower(title) FROM publications;",
    "CREATE STATISTICS article_release_stats (mcv) ON selected, (visible_after IS NOT NULL) FROM publications;",
    "CREATE STATISTICS article_release_stats (mcv) ON selected, visible_after FROM publications, articles;",
    "CREATE STATISTICS article_release_stats (mcv) ON selected, visible_after FROM publications; ANALYZE publications (selected, visible_after);",
    "ANALYZE;",
    "ANALYZE publications;",
    "ANALYZE VERBOSE publications (selected);",
    "ANALYZE publications(selected), articles(id);",
    "ANALYZE (SKIP_LOCKED) publications(selected);",
    "ANALYZE (SKIP_LOCKED true) publications(selected);",
    "ANALYZE publications (lower(title));",
    "ANALYZE publications(selected); UPDATE publications SET selected = false;",
    "ANALYZE publications (selected); SET statement_timeout = 0;",
    "VACUUM ANALYZE publications (selected);",
  ]) assert.throws(() => migrationPlan(statement), statement);
});
