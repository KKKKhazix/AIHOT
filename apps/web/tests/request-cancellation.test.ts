import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOr404 } from "../app/lib/api.server.ts";
import { adminGet } from "../app/lib/admin.server.ts";

test("public and admin loaders forward cancellation without turning it into a 503", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    assert(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  try {
    for (const load of [
      (signal: AbortSignal) => loadOr404("/api/site/items/example", { signal }),
      (signal: AbortSignal) => adminGet(new Request("http://local/admin/runs", { signal }), "/api/admin/runs"),
    ]) {
      const controller = new AbortController();
      const pending = load(controller.signal);
      controller.abort();
      await assert.rejects(pending, (error: unknown) => error === controller.signal.reason);
    }
  } finally {
    globalThis.fetch = original;
  }
});
