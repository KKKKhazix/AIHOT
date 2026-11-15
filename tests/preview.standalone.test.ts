import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Fastify from "fastify";
import { ADMIN } from "@aihot/site";
import { config } from "@aihot/backend/config";
import { installModules, serverModules } from "@aihot/backend/modules";
import { previewPrincipal } from "@aihot/backend/admin/preview";
import { previewHandler, registerAdminAuth } from "../apps/api/src/routes/admin-auth.ts";

const originalDev = config.devAdmin;
const originalEnvironment = config.environmentName;
afterEach(() => {
  installModules([]);
  config.devAdmin = originalDev;
  config.environmentName = originalEnvironment;
});

test("preview identity accepts a module cookie and keeps password routes absent on a site without admin pages", async () => {
  config.devAdmin = null;
  const viewer = { name: "reader@example.test", actor: "reader:example" };
  installModules([{ name: "example", preview: async (cookie) => cookie === "reader=valid" ? viewer : null }]);
  const app = Fastify();
  registerAdminAuth(app);
  try {
    const denied = await app.inject("/api/admin/preview");
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers["cache-control"], "private, no-store");
    const accepted = await app.inject({ url: "/api/admin/preview", headers: { cookie: "reader=valid" } });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { name: viewer.name });
    assert.equal(accepted.headers["cache-control"], "private, no-store");
    assert.deepEqual(await previewPrincipal("reader=valid"), viewer);
    if (!ADMIN) for (const [method, url] of [["GET", "/api/auth/login"], ["GET", "/api/auth/options"], ["GET", "/api/admin/me"], ["POST", "/api/auth/password"], ["POST", "/api/auth/logout"]] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 404, url);
    }
  } finally { await app.close(); }
});

test("preview data permits only GET and HEAD, and never calls the handler for rejected requests", async () => {
  config.devAdmin = null;
  installModules([{ name: "example", preview: async (cookie) => cookie ? { name: "Preview", actor: "reader:example" } : null }]);
  const app = Fastify();
  let calls = 0;
  app.route({ method: ["GET", "POST", "PUT", "DELETE"], url: "/preview-data", handler: previewHandler(async (_req, _reply, viewer) => ({ calls: ++calls, actor: viewer.actor })) });
  try {
    assert.equal((await app.inject("/preview-data")).statusCode, 401);
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const denied = await app.inject({ method, url: "/preview-data", headers: { cookie: "reader=valid" } });
      assert.equal(denied.statusCode, 405);
      assert.equal(denied.headers["cache-control"], "no-store");
    }
    assert.equal(calls, 0);
    for (const method of ["GET", "HEAD"] as const) assert.equal((await app.inject({ method, url: "/preview-data", headers: { cookie: "reader=valid" } })).statusCode, 200);
    assert.equal(calls, 2);
  } finally { await app.close(); }
});

test("development admin preview takes priority over the module and is unavailable in production", async () => {
  config.devAdmin = { displayName: "Preview developer" };
  config.environmentName = "development";
  installModules([{ name: "example", preview: async () => null }]);
  assert.deepEqual(await previewPrincipal(undefined), { name: "Preview developer", actor: "dev:Preview developer" });
  config.environmentName = "production";
  assert.equal(await previewPrincipal(undefined), null);
});

test("multiple preview providers fail installation without replacing the installed modules", () => {
  const first = { name: "first", preview: async () => null };
  installModules([first]);
  assert.throws(() => installModules([first, { name: "second", preview: async () => null }]), /preview/i);
  assert.deepEqual(serverModules(), [first]);
});
