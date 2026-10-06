import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionCache } from "../app/lib/session-cache.ts";

// Test storage semantics at the browser boundary, including denied storage and document teardown.
test("history cache keeps the last anchor and survives eviction, expiry and storage denial", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
  const windowTarget = Object.assign(new EventTarget(), { sessionStorage: storage });
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
  Object.assign(globalThis, { window: windowTarget, document: documentTarget });
  const cache = sessionCache<{ savedAt: number; value: string }>("test:", 30_000);
  const at = Date.now();
  cache.set("first", { savedAt: at, value: "one" });
  cache.set("first", { savedAt: at, value: "two" });
  assert.equal(cache.read("first")?.value, "two");
  t.mock.timers.tick(50);
  assert.equal(JSON.parse(values.get("test:first")!).value, "two");
  cache.set("first", { savedAt: at, value: "last anchor" });
  windowTarget.dispatchEvent(new Event("pagehide"));
  assert.equal(JSON.parse(values.get("test:first")!).value, "last anchor");
  for (let i = 0; i < 21; i++) cache.set(String(i), { savedAt: at, value: String(i) });
  cache.flush();
  assert.equal(cache.read("first")?.value, "last anchor", "memory eviction preserves stored history");
  values.set("test:expired", JSON.stringify({ savedAt: at - 31_000, value: "old" }));
  assert.equal(cache.read("expired"), null);
  assert.equal(values.has("test:expired"), false);
  values.set("test:broken", "{");
  assert.equal(cache.read("broken"), null);
  Object.defineProperty(windowTarget, "sessionStorage", { configurable: true, get() { throw new Error("denied"); } });
  cache.set("private", { savedAt: at, value: "memory" });
  cache.flush();
  assert.equal(cache.read("private")?.value, "memory");
  assert.equal(cache.read("missing"), null);
});
