// Failure cases: PostgreSQL includes entire values in duplicate-key detail and invalid-input
// messages; nested causes repeat those values; an OAuth provider's error text contains credentials.
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

// One process for every failed exchange: a refusal whose text names credentials, and token or profile
// answers that are not JSON (the parser would quote them).
test("OAuth rejects failed exchanges without logging the upstream response text", () => {
  const marker = "opaque-secret";
  const output = run(`
    import assert from 'node:assert/strict';
    import { buildApp } from ${JSON.stringify(API_APP_URL)};
    import { loginRedirect, STATE_COOKIE } from '@aihot/backend/admin/auth';
    process.env.FEISHU_LOGIN_APP_ID = 'synthetic-app';
    process.env.FEISHU_LOGIN_APP_SECRET = 'synthetic-secret';
    const app = await buildApp();
    const refused = async () => Response.json({error:${JSON.stringify(MARKER)}}, {status:400});
    const broken = (path) => async input => String(input).endsWith(path)
      ? new Response(${JSON.stringify(marker)}, {status:502}) : Response.json({access_token:'synthetic-token'});
    for (const upstream of [refused, broken('/token'), broken('/userinfo')]) {
      globalThis.fetch = upstream;
      const redirect = loginRedirect('/admin');
      const state = new URL(redirect.url).searchParams.get('state');
      const response = await app.inject({url:'/api/auth/callback?'+new URLSearchParams({state,code:'synthetic'}),
        headers:{cookie:STATE_COOKIE+'='+encodeURIComponent(redirect.stateCookie)}});
      assert.equal(response.statusCode,403);
      assert.ok(!response.body.includes(${JSON.stringify(MARKER)}) && !response.body.includes(${JSON.stringify(marker)}));
    }
    await app.close();
  `);
  assert.ok(!output.includes(MARKER) && !output.includes(marker), "the identity provider's text is not safe log data");
  assert.match(output, /400/, "the upstream HTTP status remains diagnosable");
  assert.match(output, /502/);
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
