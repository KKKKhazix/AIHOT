// Which models the admin may choose for a step: only a step that needs images refuses a text model.
// A name no model answers to is passed over, and the admin page is told which one.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { CAPABILITIES, capabilityAcceptsModel, invalidateModelCache, modelFor, modelSources } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";

after(closeDb);

test("every step takes a model that reads images; only a step that needs images refuses a text model", async () => {
  const understand = CAPABILITIES.understand;
  assert.equal(capabilityAcceptsModel(understand, MODELS["glm-5.3-flash"]!), true);
  assert.equal(capabilityAcceptsModel(understand, MODELS["qwen3-vl-flash"]!), true);
  assert.equal(capabilityAcceptsModel(understand, MODELS["deepseek-flash"]!), true);
  assert.equal(capabilityAcceptsModel(CAPABILITIES.score, MODELS["qwen3-vl-flash"]!), true);
  assert.equal(capabilityAcceptsModel({ ...understand, vision: true }, MODELS["deepseek-flash"]!), false);

  await switchModel("understand", "qwen3-vl-flash", "vision routing test", "test");
  assert.equal(await modelFor("understand"), "qwen3-vl-flash");
  await switchModel("understand", "deepseek-flash", "text routing test", "test");
  assert.equal(await modelFor("understand"), "deepseek-flash");

  const overview = await modelsOverview(1);
  assert.equal(overview.capabilities.find((capability) => capability.key === "understand")?.vision, false);
});

test("a switch or environment variable naming no model is passed over and reported", async () => {
  const env = CAPABILITIES.score.env;
  const before = process.env[env];
  const pin = async (model: string | null) => {
    if (model) await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.score', ${sql.json({ model })}, 'test')
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    else await sql`DELETE FROM settings WHERE key = 'models.score'`;
    invalidateModelCache();
  };
  const source = async () => (await modelSources()).score!;
  try {
    process.env[env] = "gone-from-env";
    await pin(null);
    assert.deepEqual(await source(), { model: CAPABILITIES.score.default, source: "default", invalid: "gone-from-env" });
    assert.equal(await modelFor("score"), CAPABILITIES.score.default);

    process.env[env] = "deepseek-flash";
    await pin("gone-from-settings");
    assert.deepEqual(await source(), { model: "deepseek-flash", source: "env", invalid: "gone-from-settings" });
    assert.equal(await modelFor("score"), "deepseek-flash");

    process.env[env] = "gone-from-env";
    await pin("deepseek-flash");
    assert.deepEqual(await source(), { model: "deepseek-flash", source: "admin" }, "a name that is not in use costs nothing yet");

    process.env[env] = "deepseek-flash";
    await pin(null);
    assert.deepEqual(await source(), { model: "deepseek-flash", source: "env" });
  } finally {
    await pin(null);
    if (before === undefined) delete process.env[env]; else process.env[env] = before;
    invalidateModelCache();
  }
});
