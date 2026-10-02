import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { discoverConnectionModels, encryptModelKey, decryptModelKey, invalidateConnectionCache, loadModelConnection, normalizeModelBaseUrl, publicModelConnection, resolveModelConnection, saveModelConnection } from "@aihot/backend/providers/model-connection";
import { defaultModelExtra, recognizeModelProvider } from "@aihot/contracts/model-connection";
import Fastify from "fastify";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";
import { config } from "@aihot/backend/config";
import { endSession, passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";

const T = tag();
before(async () => {
  await sql`DELETE FROM settings WHERE key = 'model_connection'`;
  invalidateConnectionCache();
});
after(async () => {
  await sql`DELETE FROM settings WHERE key = 'model_connection'`;
  invalidateConnectionCache();
  await closeDb();
});

test("recognition does not guess generic or relay keys from a model name", () => {
  assert.equal(recognizeModelProvider("sk-ws-example.test-key"), "dashscope");
  assert.equal(recognizeModelProvider("sk-proj-example-key"), "openai");
  assert.equal(recognizeModelProvider("sk-generic-key"), null);
  assert.throws(() => resolveModelConnection({ provider: "auto", apiKey: "sk-generic-key", model: "qwen-plus" }), /选择服务商/);
  const c = resolveModelConnection({ provider: "deepseek", apiKey: "test-key" });
  assert.equal(c.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(c.model, "deepseek-flash");
});

test("relay URLs normalize without losing nonstandard prefixes; unsafe URL fields are rejected", () => {
  assert.equal(normalizeModelBaseUrl("https://relay.example/"), "https://relay.example/v1");
  assert.equal(normalizeModelBaseUrl("https://relay.example/api/v1/chat/completions/"), "https://relay.example/api/v1");
  assert.equal(normalizeModelBaseUrl("https://relay.example/openai"), "https://relay.example/openai");
  for (const url of ["http://relay.example/v1", "https://user:secret@relay.example/v1", "https://relay.example/v1?key=test", "file:///secret"]) {
    assert.throws(() => normalizeModelBaseUrl(url));
  }
});

test("a retained key is never carried to a different endpoint; extras match the selected model", () => {
  const before = resolveModelConnection({ provider: "dashscope", apiKey: "test-key" });
  assert.equal(resolveModelConnection({ provider: "dashscope", model: "qwen-plus" }, before).apiKey, "test-key");
  assert.throws(() => resolveModelConnection({ provider: "deepseek" }, before), /API Key/);
  assert.deepEqual(defaultModelExtra("custom", "Qwen/qwen3.8-flash"), { enable_thinking: false });
  assert.deepEqual(defaultModelExtra("custom", "gpt-4.1-mini"), {});
  assert.deepEqual(resolveModelConnection({ provider: "dashscope", apiKey: "test-key", extraJson: "{}" }).extra, {});
  assert.throws(() => resolveModelConnection({ provider: "dashscope", apiKey: "test-key", extraJson: '{"model":"other"}' }), /不能覆盖/);
});

test("key encryption detects tampering and stores no plaintext or key in public views", async () => {
  const key = `test-secret-${T}`;
  const encrypted = encryptModelKey(key);
  assert.equal(decryptModelKey(encrypted), key);
  assert.ok(!encrypted.includes(key));
  assert.throws(() => decryptModelKey(`bad.${encrypted}`), /无法解密/);
  const saved = await saveModelConnection({ provider: "dashscope", apiKey: key }, "test-admin");
  assert.ok(saved.hasKey);
  assert.ok(!JSON.stringify(saved).includes(key));
  const [row] = await sql`SELECT value FROM settings WHERE key = 'model_connection'`;
  assert.ok(!JSON.stringify(row!.value).includes(key));
  const [audit] = await sql`SELECT before, after FROM audit_log WHERE action='models.connection' ORDER BY id DESC LIMIT 1`;
  assert.ok(!JSON.stringify(audit).includes(key));
});

test("relay model listing sanitizes responses and runtime switches take effect without restarting", async () => {
  let chatCalls = 0;
  const modelsSeen: string[] = [];
  const server = await stub((_n, req) => {
    if (req.url.endsWith("/models")) return { data: [{ id: "relay-model-a" }, { id: "relay-model-b" }, { id: "bad model" }, { id: "relay-model-a" }, { id: 3 }], secret: "must-not-be-returned" };
    chatCalls++;
    const body = JSON.parse(req.body);
    modelsSeen.push(body.model);
    return { id: `connection-${T}-${chatCalls}`, choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  });
  try {
    const base = { provider: "custom" as const, apiKey: "test-relay-key", baseUrl: `${server.url}/v1`, model: "relay-model-a" };
    const listing = await discoverConnectionModels(base);
    assert.deepEqual(listing, { models: ["relay-model-a", "relay-model-b"] });
    assert.equal(chatCalls, 0, "discovery does not call a paid chat endpoint");
    await saveModelConnection(base, "test-admin");
    process.env.MODEL_CALLS_ENABLED = "true";
    const { config } = await import("@aihot/backend/config");
    config.modelCallsEnabled = true;
    const opts = { model: "default", purpose: "connection_test", subject: `connection:${T}`, promptVersion: "1", system: "json", user: "test", schema: z.object({ ok: z.boolean() }) };
    assert.equal((await chatJson(opts)).data.ok, true);
    await saveModelConnection({ ...base, apiKey: "", model: "relay-model-b" }, "test-admin");
    assert.equal((await chatJson(opts)).data.ok, true);
    assert.deepEqual(modelsSeen, ["relay-model-a", "relay-model-b"]);
    assert.equal(publicModelConnection(await loadModelConnection()).model, "relay-model-b");
  } finally { await server.close(); }
});

test("connection editing and model discovery require administrator authentication and CSRF", async () => {
  const app = Fastify({ logger: false });
  registerAdmin(app);
  const original = { password: config.adminPassword, dev: config.devAdmin };
  config.adminPassword = `test-admin-password-${T}`;
  config.devAdmin = null;
  let token = "";
  try {
    for (const [method, url] of [["PUT", "/api/admin/models/connection"], ["POST", "/api/admin/models/connection/models"]] as const) {
      assert.equal((await app.inject({ method, url, payload: { provider: "deepseek", apiKey: "test-key" } })).statusCode, 401);
    }
    token = (await passwordLogin(config.adminPassword, "/admin", "test")).token;
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/models/connection", headers: { cookie: `${SESSION_COOKIE}=${token}` }, payload: { provider: "deepseek", apiKey: "test-key" } })).statusCode, 403);
  } finally {
    if (token) await endSession(`${SESSION_COOKIE}=${token}`);
    config.adminPassword = original.password;
    config.devAdmin = original.dev;
    await app.close();
  }
});
