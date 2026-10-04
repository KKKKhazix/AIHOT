// A failed structure, which leaves the current identity unresolved, must still block the next paid
// step: no separate writing request starts. The stub answers each step; semantic extraction is
// checked on real samples.
import { pointModels, stub, tag } from "./setup.ts";
import { analysisStep, SELECTING_SCORE } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { runAnalysis } from "@aihot/backend/editorial/analyze";

const steps: string[] = [];
const provider = await stub((_hit, request) => {
  const step = analysisStep(request.body);
  steps.push(step);
  const result = step === "prefilter" ? { label: "PASS", reason: "fixture" } : step === "score" ? { attentionScore: SELECTING_SCORE } : "invalid output";
  return { choices: [{ message: { content: typeof result === "string" ? result : JSON.stringify(result) } }] };
});
pointModels(provider.url);
after(async () => { await provider.close(); await closeDb(); });

test("an unresolved current identity does not start a separate writing request", async () => {
  const text = "We released Manus 2.0 on September 28. Today we explain Game Dev's editing workflow.";
  await assert.rejects(runAnalysis({ id: `identity-${tag()}`, revision: 1, title: "Manus Game Dev", url: "https://example.org/news", author: null,
    publishedAt: new Date("2026-10-02T00:00:00Z"), bodyStatus: "ok", bodyText: text, excerpt: null, media: [], xPost: null,
    source: { name: "Fixture", kind: "rss", tier: "T1", firstParty: true } }));
  assert.ok(steps.includes("structure"));
  assert.equal(steps.filter((s) => s === "understand" || s === "summarize").length, 0);
});
