// The open-source migrations keep their own numbers: every number is used once, and the session binding
// migration can run again over an install that already has its columns without touching their data.
import "./setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const dir = path.join(REPO_ROOT, "database/migrations");
const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
const binding = files.find((file) => file.endsWith("_admin_session_binding.sql"))!;
const migration = readFileSync(path.join(dir, binding), "utf8");
after(closeDb);

test("session binding migration follows upstream migrations with a unique number", () => {
  const numbers = files.map((file) => file.split("_")[0]);
  assert.equal(new Set(numbers).size, numbers.length, "migration numbers must be unique");
  assert.equal(binding, "0041_admin_session_binding.sql");
});

test("session binding migration preserves an already-installed binding and legacy rows", async () => {
  await sql.begin(async (tx) => {
    // A temporary table hides the real one: running the migration again keeps the columns' data.
    await tx`CREATE TEMP TABLE admin_sessions (id_hash text PRIMARY KEY) ON COMMIT DROP`;
    await tx`INSERT INTO admin_sessions VALUES ('legacy')`;
    await tx.unsafe(migration);
    await tx`INSERT INTO admin_sessions VALUES ('bound', 'password', 'original-binding', NULL)`;
    await tx.unsafe(migration);
    const rows = await tx`SELECT * FROM admin_sessions ORDER BY id_hash`;
    assert.deepEqual([...rows], [
      { id_hash: "bound", auth_method: "password", auth_binding: "original-binding", auth_claims: null },
      { id_hash: "legacy", auth_method: null, auth_binding: null, auth_claims: null },
    ]);
    await assert.rejects(tx.savepoint(async (sp) => {
      await sp`INSERT INTO admin_sessions (id_hash, auth_method) VALUES ('invalid', 'unknown')`;
    }), { code: "23514" });
  });
});
