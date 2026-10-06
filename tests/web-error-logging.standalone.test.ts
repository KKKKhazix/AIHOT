// Failure cases: ordinary missing routes flood the journal; ignoring every route response hides 5xx;
// loader timeouts become anonymous 503s; logs leak query strings; real crashes lose their stacks;
// a visitor cancelling a request is mistaken for an upstream failure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { data } from "react-router";
import { handleError } from "../apps/web/app/lib/errors.server.ts";
import { apiGet, loadOr404 } from "../apps/web/app/lib/api.server.ts";

test("expected route refusals and cancelled requests stay quiet; real errors keep request and stack", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  const request = new Request("https://example.test/missing?token=query-only-secret-9386&aihot_actor=query-only-secret-9386");
  handleError({ status: 404, statusText: "Not Found", internal: true, data: "missing", error: new Error("No route matches") }, { request });
  handleError({ status: 405, statusText: "Method Not Allowed", internal: true, data: "method" }, { request });
  const controller = new AbortController();
  controller.abort();
  handleError(new Error("cancelled"), { request: new Request(request, { signal: controller.signal }) });
  assert.deepEqual(lines, []);
  const error = new TypeError("render exploded");
  handleError(error, { request });
  const record = JSON.parse(lines[0]!);
  assert.equal(record.path, "/missing");
  assert.equal(record.method, "GET");
  assert.equal(record.err.stack, error.stack);
  assert.equal(record.err.name, "TypeError");
  assert.ok(!lines.join("\n").includes("query-only-secret-9386"));
  handleError({ status: 503, statusText: "Unavailable", internal: true, data: "failed", error }, { request });
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]!).err.stack, error.stack);
});

test("SSR fetch timeouts keep the upstream path and stack before the existing 503 mapping", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  const error = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  t.mock.method(globalThis, "fetch", async () => { throw error; });
  await assert.rejects(loadOr404("/api/site/timeline?q=query-only-secret-9386&aihot_actor=query-only-secret-9386"), (thrown) => {
    assert.deepEqual(thrown, data({ message: "unavailable" }, { status: 503 }));
    return true;
  });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.path, "/api/site/timeline");
  assert.equal(record.method, "GET");
  assert.equal(record.err.name, "TimeoutError");
  assert.equal(record.err.stack, error.stack);
  assert.ok(!lines[0]!.includes("query-only-secret-9386"));
});

test("SSR keeps ordinary upstream misses and caller cancellations quiet", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 404 }));
  await assert.rejects(loadOr404("/api/site/items/missing"), (error) => {
    assert.deepEqual(error, data({ message: "not_found" }, { status: 404 }));
    return true;
  });
  const controller = new AbortController();
  controller.abort();
  fetched.mock.mockImplementation(async () => { throw controller.signal.reason; });
  await assert.rejects(apiGet("/api/site/timeline", { signal: controller.signal }));
  assert.deepEqual(lines, []);
});
