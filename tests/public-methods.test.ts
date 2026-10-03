// Rejected public methods have one protocol response, even when their body cannot be parsed.
// Failure modes: body parsing masks 405, CORS is missing on the error, and TRACE falls into 404.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { InjectOptions } from "fastify";
import { closeDb } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("public read-only endpoints reject methods before interpreting their bodies", async () => {
  for (const url of ["/api/v1", "/api/v1/items", "/openapi-v1.json"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "TRACE"] as const) {
      for (const contentType of ["application/json", "application/octet-stream"]) {
        // Fastify and the injector accept TRACE at runtime; light-my-request omits it from its type.
        const res = await app.inject({ method: method as InjectOptions["method"], url, headers: { "content-type": contentType }, payload: "{" });
        assert.equal(res.statusCode, 405, `${method} ${url} ${contentType}`);
        assert.equal(res.json().code, "method_not_allowed");
        assert.equal(res.headers["access-control-allow-origin"], "*");
        assert.equal(res.headers.allow, "GET, HEAD, OPTIONS");
        assert.equal(res.headers["cache-control"], "no-store");
      }
    }
  }
});
