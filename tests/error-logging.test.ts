// Failure cases: PostgreSQL includes entire values in duplicate-key detail and invalid-input
// messages; nested causes repeat those values.
import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const MARKER = "synthetic-private-person@example.test";
const API_APP_URL = new URL("../apps/api/src/app.ts", import.meta.url).href;
function run(source: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, LOG_LEVEL: "error", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("API error logs keep database codes and frames without row values or query parameters", () => {
  const output = run(`
    import { buildApp } from ${JSON.stringify(API_APP_URL)};
    import { sql, closeDb } from '@aihot/backend/db';
    const app = await buildApp();
    const marker = ${JSON.stringify(MARKER)};
    for (const kind of ['unique', 'input']) {
      try {
        await sql.begin(async tx => {
          if (kind === 'input') return tx\`SELECT \${marker}::integer\`;
          await tx\`INSERT INTO admin_users(email,display_name) VALUES (\${marker},'Synthetic')\`;
          await tx\`INSERT INTO admin_users(email,display_name) VALUES (\${marker},'Synthetic')\`;
        });
      } catch (error) {
        app.log.error({err:error}, 'database-boundary');
        app.log.error({err:new Error('database operation failed', {cause:error})}, 'nested-database-boundary');
      }
    }
    await app.close(); await closeDb();
  `);
  assert.ok(!output.includes(MARKER), "database values must not enter the log");
  assert.match(output, /23505/);
  assert.match(output, /22P02/);
  assert.match(output, /at /, "keep locations useful for diagnosis");
  assert.ok(!output.includes('parameters') && !output.includes('detail'));
});

test("the queue's PostgreSQL driver also keeps values out of worker error logs", () => {
  const output = run(`
    import { PgBoss } from 'pg-boss';
    import { logError } from '@aihot/backend/lib/log-error';
    const boss = new PgBoss({connectionString:process.env.DATABASE_URL});
    await boss.start();
    try {
      await boss.getDb().executeSql('SELECT $1::integer', [${JSON.stringify(MARKER)}]);
    } catch (error) {
      console.log(JSON.stringify(logError(error)));
    } finally {await boss.stop({graceful:false});}
  `);
  assert.ok(!output.includes(MARKER));
  assert.match(output, /22P02/);
});
