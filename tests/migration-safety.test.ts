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
