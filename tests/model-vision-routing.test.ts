// Which models a step may use (admin) and whether it is sent an image (runtime) read the same flag.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import {
  CAPABILITIES,
  capabilityAcceptsModel,
  modelFor,
  modelSupportsVision,
} from "@aihot/backend/editorial/models";
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

test("runtime image attachment is explicit rather than probing presets with unspecified vision support", () => {
  assert.equal(modelSupportsVision("qwen3-vl-flash"), true);
  assert.equal(modelSupportsVision("glm-5.3-flash"), true);
  assert.equal(modelSupportsVision("qwen3.8-flash"), false);
  assert.equal(modelSupportsVision("default"), process.env.LLM_VISION === "true");
});
