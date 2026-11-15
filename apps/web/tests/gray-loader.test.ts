import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { adminGet, grayGet } from "../app/lib/admin.server.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const request = new Request("https://example.test/preview/example", { headers: { cookie: "reader=valid" } });
const notFound = (error: unknown) => (error as { init?: { status?: number }; data?: { message?: string } }).init?.status === 404;

test("gray loaders check preview identity and hide both denied identity and revoked data access", async () => {
  for (const status of [401, 200]) {
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      assert.equal(new Headers(init?.headers).get("cookie"), "reader=valid");
      return Response.json({}, { status: path === "/api/admin/preview" ? status : 401 });
    };
    await assert.rejects(grayGet(request, "/api/preview-data"), notFound);
    assert.deepEqual(paths, status === 401 ? ["/api/admin/preview"] : ["/api/admin/preview", "/api/preview-data"]);
  }
});

test("preview data loads successfully while ordinary admin data still redirects to sign-in", async () => {
  globalThis.fetch = async () => Response.json({ title: "Preview" });
  assert.deepEqual(await grayGet(request, "/api/preview-data"), { title: "Preview" });
  globalThis.fetch = async () => Response.json({}, { status: 401 });
  await assert.rejects(adminGet(request, "/api/admin/example"), (error: unknown) => error instanceof Response && error.status === 302 && error.headers.get("location")!.startsWith("/api/auth/login?"));
});

test("a preview identity service failure remains an error, not a missing page", async () => {
  globalThis.fetch = async () => Response.json({ detail: "identity unavailable" }, { status: 500 });
  await assert.rejects(grayGet(request, "/api/preview-data"), (error: unknown) => (error as { init?: { status?: number } }).init?.status === 503);
});
