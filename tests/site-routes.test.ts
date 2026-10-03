// The site's own endpoints and the Agent Markdown answers keep their contracts.
import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

process.env.FEISHU_INTERNAL_ENABLED = "false";
const app = await buildApp();
after(async () => {
  await app.close();
  await closeDb();
});

test("current browser feedback and reset polling still work", async () => {
  const form = new FormData();
  form.set("content", `Current browser feedback ${randomUUID()}`);
  form.set("email", "reader@example.com");
  form.set("pageUrl", "/about");
  const posted = new Request("http://local/api/site/feedback", { method: "POST", body: form });
  const feedback = await app.inject({
    method: "POST", url: "/api/site/feedback",
    headers: { "content-type": posted.headers.get("content-type")! }, payload: Buffer.from(await posted.arrayBuffer()),
  });
  assert.equal(feedback.statusCode, 201);
  const [saved] = await sql<{ email: string; note: string | null }[]>`SELECT email, note FROM feedback WHERE id = ${feedback.json().id}`;
  assert.deepEqual({ ...saved }, { email: "reader@example.com", note: null });

  const version = await app.inject({ method: "GET", url: "/api/site/codex-reset/version" });
  assert.equal(version.statusCode, 200);
  assert.equal(version.headers["cache-control"], "public, max-age=0, s-maxage=15");
  assert.equal(typeof version.json().version, "string");
});

test("agents read Markdown answers under /api/v1/agent", async () => {
  const get = (url: string) => app.inject({ method: "GET", url });
  const guide = await get("/api/v1/agent");
  assert.equal(guide.statusCode, 200);
  assert.match(String(guide.headers["content-type"]), /^text\/markdown/);
  for (const path of ["/latest", "/search", "/hot", "/daily", "/codex-resets"]) assert.ok(guide.body.includes(`${config.siteUrl}/api/v1/agent${path}`), path);
  for (const url of ["/api/v1/agent/latest", "/api/v1/agent/latest?window=7d&mode=all&category=paper&limit=5", "/api/v1/agent/search?q=OpenAI", "/api/v1/agent/hot", "/api/v1/agent/codex-resets"]) {
    const res = await get(url);
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
    assert.match(res.body, /## 回答提示/, url);
    assert.match(String(res.headers["cache-control"]), /^public/, url);
    assert.equal(res.headers["access-control-allow-origin"], "*", url);
  }
  // Parameters are checked like v1's; a story or daily nobody was given is a 404, never a guess.
  for (const url of ["/api/v1/agent/latest?days=3", "/api/v1/agent/latest?limit=31", "/api/v1/agent/search?q=x", "/api/v1/agent/daily/2026-02-30"]) assert.equal((await get(url)).statusCode, 400, url);
  for (const url of ["/api/v1/agent/stories/no-such-story", "/api/v1/agent/daily/2099-01-01"]) assert.equal((await get(url)).statusCode, 404, url);
});
