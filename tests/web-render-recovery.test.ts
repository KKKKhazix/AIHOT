/// <reference lib="dom" />
// A render failure in an old tab may recover once after a release, without hiding current failures.
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createRenderErrorHandler } from "../apps/web/app/lib/render-recovery.ts";

const KEY = "aihot-render-recovery-release";
const ORIGIN = "https://news.example.com";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  mock.restoreAll();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function browser(path = "/topics/openai?page=2#latest", stored = new Map<string, string>()) {
  const location = { href: `${ORIGIN}${path}`, reload: mock.fn() };
  const sessionStorage = {
    getItem: mock.fn((key: string) => stored.get(key) ?? null),
    setItem: mock.fn((key: string, value: string) => { stored.set(key, value); }),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location, sessionStorage } });
  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ ok: true, release: "release-B" }));
  const log = mock.method(console, "error", () => {});
  return { location, sessionStorage, stored, fetch, log };
}

function errorInfo(path = "/topics/openai?page=2#latest", render = true) {
  const url = new URL(path, ORIGIN);
  return {
    location: { pathname: url.pathname, search: url.search, hash: url.hash, state: null, key: "topic" },
    params: {}, pattern: "/topics/:slug",
    ...(render ? { errorInfo: { componentStack: "at TopicRoute" } } : {}),
  };
}

test("an old document render failure checks fresh health and reloads its exact URL once", async () => {
  const b = browser();
  const error = new TypeError("Cannot read properties of undefined (reading 'length')");
  const info = errorInfo();
  const onError = createRenderErrorHandler("release-A");
  await onError(error, info);
  assert.equal(b.fetch.mock.calls.length, 1);
  assert.equal(b.fetch.mock.calls[0]!.arguments[0], "/api/health");
  assert.equal(b.fetch.mock.calls[0]!.arguments[1]?.cache, "no-store");
  assert.equal(b.location.reload.mock.calls.length, 1);
  assert.equal(b.location.href, `${ORIGIN}/topics/openai?page=2#latest`);
  assert.equal(b.stored.get(KEY), "release-A");
  assert.equal(b.log.mock.calls[0]!.arguments[0], error, "the original failure remains in the console");
  await onError(error, info);
  await createRenderErrorHandler("release-A")(error, info); // A cache can return the same old HTML after reload.
  assert.equal(b.location.reload.mock.calls.length, 1);
});

test("current releases and unsuccessful health checks keep the error page", async () => {
  const replies = [
    () => Response.json({ ok: true, release: "release-A" }),
    () => Response.json({ ok: false, release: "release-B" }),
    () => Response.json({ ok: true }),
    () => Response.json({ ok: true, release: "" }),
    () => Response.json({ ok: true, release: "dev" }),
    () => Response.json({ ok: true, release: 123 }),
    () => Response.json({ ok: true, release: "release-B" }, { status: 503 }),
    () => new Response("<html>challenge</html>"),
    () => { throw new TypeError("Failed to fetch"); },
  ];
  for (const reply of replies) {
    const b = browser();
    b.fetch.mock.mockImplementation(async () => reply());
    await createRenderErrorHandler("release-A")(new TypeError("render failed"), errorInfo());
    assert.equal(b.location.reload.mock.calls.length, 0);
    assert.equal(b.stored.size, 0);
    mock.restoreAll();
  }
});

test("route responses, loader/network failures, admin and unversioned documents never probe health", async () => {
  const b = browser();
  const onError = createRenderErrorHandler("release-A");
  for (const status of [404, 503]) {
    await onError({ status, statusText: "Error", internal: false, data: {} }, errorInfo());
  }
  await onError(new TypeError("Failed to fetch"), errorInfo(undefined, false));
  for (const path of ["/admin", "/admin/content/1"]) {
    b.location.href = `${ORIGIN}${path}`;
    await onError(new Error("admin render failed"), errorInfo(path));
  }
  b.location.href = `${ORIGIN}/topics/openai?page=2#latest`;
  for (const release of [null, "", "dev"]) {
    await createRenderErrorHandler(release)(new Error("render failed"), errorInfo());
  }
  assert.equal(b.fetch.mock.calls.length, 0);
  assert.equal(b.location.reload.mock.calls.length, 0);
});

test("blocked storage never risks an automatic reload loop", async () => {
  for (const method of ["getItem", "setItem"] as const) {
    const b = browser();
    b.sessionStorage[method].mock.mockImplementation(() => { throw new Error("storage disabled"); });
    await createRenderErrorHandler("release-A")(new Error("render failed"), errorInfo());
    assert.equal(b.location.reload.mock.calls.length, 0);
    mock.restoreAll();
  }
  const b = browser();
  Object.defineProperty(window, "sessionStorage", { get() { throw new Error("storage disabled"); } });
  await createRenderErrorHandler("release-A")(new Error("render failed"), errorInfo());
  assert.equal(b.location.reload.mock.calls.length, 0);
});
