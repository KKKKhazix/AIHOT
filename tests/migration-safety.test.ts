// Failure cases for online migrations: table scans under strong locks, unsafe retries, and hidden SQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { indexOnEmptyTable, migrationPlan } from "../scripts/migration-safety.ts";

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
    "ALTER TABLE articles DROP COLUMN flag;",
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

test("index definition checks preserve compound operators, adjacent comments and negative operands", () => {
  for (const [predicate, normalized] of [
    ["output->>'scope'='composite'", "output ->> 'scope' = 'composite'"],
    ["output#>>'{kind,name}'='release'", "output #>> '{kind,name}' = 'release'"],
    ["output@>'{\"active\":true}'::jsonb", "output @> '{\"active\":true}' :: jsonb"],
    ["id<=-1", "id <= -1"],
    ["output->-1 IS NOT NULL", "output -> -1 IS NOT NULL"],
    ["title!~*'-- /* ->> <= literal'", "title !~* '-- /* ->> <= literal'"],
    ["tags&&ARRAY['one','two']", "tags && ARRAY [ 'one' , 'two' ]"],
    ["point<->other_point<10", "point <-> other_point < 10"],
    ["output->>/* scope */'scope'<>'single' AND id>=-- boundary\n0", "output ->> 'scope' <> 'single' AND id >= 0"],
  ]) {
    const source = `CREATE INDEX CONCURRENTLY IF NOT EXISTS example_idx ON example (id) WHERE ${predicate};`;
    assert.equal(indexOnEmptyTable(source), `CREATE INDEX migration_expected_index ON pg_temp.migration_expected_table ( id ) WHERE ${normalized}`);
    assert.equal(migrationPlan(source).kind, "index");
  }
});
