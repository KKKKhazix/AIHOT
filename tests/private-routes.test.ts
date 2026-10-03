import { createHmac } from "node:crypto";
import { config } from "@aihot/backend/config";
// Malformed optional client data must not break admin authentication or drop valid ingest entries.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { buildApp } from "../apps/api/src/app.ts";

process.env.INGEST_TOKEN = "private-route-test-ingest-token";
const app = await buildApp();
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

test("an unrelated malformed cookie leaves a real admin session usable without admitting invalid sessions", async () => {
  const token = `session-${tag()}`;
  const [user] = await sql<{ id: number }[]>`INSERT INTO admin_users (display_name) VALUES ('Cookie test') RETURNING id`;
  const claims = { appId: "test-session-app", unionId: "test-session-user", email: null };
  process.env.FEISHU_LOGIN_APP_ID = claims.appId;
  process.env.FEISHU_LOGIN_APP_SECRET = "test-app-secret";
  config.adminUnionIds = [claims.unionId];
  const binding = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(["admin-session-v1", "feishu", claims])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, auth_method, auth_binding, auth_claims)
            VALUES (${sha256(token)}, ${user!.id}, 'cookie-test-csrf', now() + interval '1 hour', 'feishu', ${binding}, ${sql.json(claims)})`;

  for (const cookie of ["unrelated=%", "aihot_admin=%; unrelated=%E0%A4", "aihot_admin=forged; unrelated=%"]) {
    const denied = await app.inject({ url: "/api/auth/check", headers: { cookie } });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers["cache-control"], "no-store");
  }

  const headers = { cookie: `unrelated=%; aihot_admin=${token}; another=%E0%A4` };
  const check = await app.inject({ url: "/api/auth/check", headers });
  assert.equal(check.statusCode, 204);
  const me = await app.inject({ url: "/api/admin/me", headers });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().name, "Cookie test");
  assert.equal(me.json().csrf, "cookie-test-csrf");
  const write = await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {} });
  assert.equal(write.statusCode, 403, "the usable session still needs CSRF for writes");

  const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers });
  assert.equal(logout.statusCode, 303);
  const ended = await app.inject({ url: "/api/auth/check", headers });
  assert.equal(ended.statusCode, 401);
});

test("ingest skips malformed entries and still accepts and deduplicates the valid entries in their batch", async () => {
  const sourceId = `ingest-${tag()}`;
  const url = `https://example.com/${sourceId}`;
  const payload = {
    sourceId,
    items: [null, false, 7, "invalid", [], {}, { title: "valid", url }, null, { title: "duplicate", url: `${url}?utm_source=duplicate` }],
  };
  const denied = await app.inject({ method: "POST", url: "/api/ingest/items", payload });
  assert.equal(denied.statusCode, 401);
  const headers = { authorization: `Bearer ${process.env.INGEST_TOKEN}` };
  const first = await app.inject({ method: "POST", url: "/api/ingest/items", headers, payload });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { ok: true, created: 1 });
  const again = await app.inject({ method: "POST", url: "/api/ingest/items", headers, payload });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { ok: true, created: 0 });
  const articles = await sql<{ title: string; url: string }[]>`SELECT title, url FROM articles WHERE source_id = ${sourceId}`;
  assert.deepEqual(articles.map((row) => ({ ...row })), [{ title: "valid", url }]);
  const [source] = await sql<{ participation_mode: string }[]>`SELECT participation_mode FROM sources WHERE id = ${sourceId}`;
  assert.equal(source!.participation_mode, "isolated");
});
