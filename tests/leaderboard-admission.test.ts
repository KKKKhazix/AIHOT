// Failure modes: a tier or absent fallback label falsely proves a single model; an explicit row
// exception inherits an audited default; a new harness/version reuses old approval; direct/tool
// composites lose their parts; publication time or attempts become run time/N.
import assert from "node:assert/strict";
import { test } from "node:test";
import { admissionOf, annotateEvaluation } from "@aihot/backend/leaderboard/fetch/admission";
import { configurationOf, scaffolded } from "@aihot/backend/leaderboard/fetch/configuration";
import type { FetchResult, ParsedRow } from "@aihot/backend/leaderboard/fetch/types";

const row = (name = "gpt-6-1-sol"): ParsedRow => ({
  sourceModelName: name, baseName: name, configuration: configurationOf(["max"]),
  metricKey: "test", metricName: "test", rawScore: 70,
});
const result = (sourceKey: string, rows: ParsedRow[], metadata: Record<string, unknown> = {}): FetchResult => ({
  sourceKey, sourceName: sourceKey, sourceUrl: "https://example.org/results", attributionUrl: "https://example.org/",
  license: "test", publishedAt: "2026-09-29T00:00:00Z", rows, metadata,
});

test("an unknown source cannot qualify through a first-party tier or self-asserted metadata", () => {
  for (const r of [row(), { ...row(), metadata: { evaluation: { mode: "DIRECT", fallback: "NONE" } } }]) {
    const a = admissionOf("unreviewed-source", r);
    assert.equal(a.eligible, false);
    assert.equal(a.mode, "UNKNOWN");
    assert.equal(a.fallback, "UNKNOWN");
  }
});

test("an audited direct protocol permits its stated default without inventing a reasoning tier", () => {
  const a = admissionOf("epoch-chess", { ...row(), configuration: configurationOf([]) });
  assert.equal(a.eligible, true);
  assert.equal(a.mode, "DIRECT");
  assert.equal(a.fallback, "NONE");
  assert.ok(a.scope);
  assert.ok(a.evidenceUrls.includes("https://epoch.ai/benchmarks/chess-puzzles"));
});

test("fallback evidence overrides both audited defaults and a composite's ordinary reference reason", () => {
  const rows = [
    { ...row(), configuration: configurationOf(["max", "default fallback"]) },
    { ...row(), metadata: { evaluation: { fallback: "PRESENT" } } },
    { sourceModelName: "model", configurationKey: "first_party:max+default-fallback@model" },
  ];
  for (const r of rows) {
    const a = admissionOf("artificial-analysis", r);
    assert.equal(a.eligible, false);
    assert.equal(a.fallback, "PRESENT");
    assert.match(a.reason!, /回退|混合/);
  }
});

test("a recorded unknown mode, a row exception and special systems cannot inherit a direct protocol", () => {
  assert.equal(admissionOf("epoch-gpqa", { ...row(), metadata: { evaluation: { mode: "UNKNOWN" } } }).eligible, false);
  assert.equal(admissionOf("epoch-gpqa", { ...row(), configuration: { ...configurationOf([]), ineligible: "专用系统" } }).eligible, false);
  assert.equal(admissionOf("arena-vision", { ...row(), configuration: scaffolded(configurationOf([]), ["custom-harness"], ["Custom"]) }).eligible, false);
});

test("only the disclosed Vals Opus 5 configuration is excluded, including old stored rows", () => {
  const excluded = admissionOf("vals-finance-agent", { sourceModelName: "anthropic/claude-opus-5", metadata: { benchmarkVersion: "2" } });
  assert.equal(excluded.eligible, false);
  assert.equal(excluded.fallback, "PRESENT");
  for (const name of ["anthropic/claude-opus-5-5", "anthropic/claude-opus-4-8"]) {
    assert.equal(admissionOf("vals-finance-agent", { sourceModelName: name }).eligible, true, name);
  }
});

test("a reviewed fixed harness is eligible, while a different harness or benchmark version is not", () => {
  assert.equal(admissionOf("deepswe-v1-1", { ...row(), metadata: { harness: "mini-swe-agent" } }).eligible, true);
  assert.equal(admissionOf("deepswe-v1-1", { ...row(), metadata: { harness: "claude-code" } }).eligible, false);
  assert.equal(admissionOf("mercor-apex-agents", { ...row(), metadata: { harness: "loop_truncated_tools_agent", benchmarkVersion: "1.1" } }).eligible, true);
  assert.equal(admissionOf("mercor-apex-agents", { ...row(), metadata: { harness: "native-agent" } }).eligible, false);
  assert.equal(admissionOf("vals-finance-agent", { ...row(), metadata: { benchmarkVersion: "3" } }).eligible, false);
  assert.equal(admissionOf("epoch-chess", { ...row(), metadata: { evaluation: { protocolId: "unreviewed-replacement" } } }).eligible, false);
});

test("source composites and heterogeneous systems remain readable references", () => {
  for (const key of ["artificial-analysis", "arena-text", "arena-webdev", "taptap-maker"]) {
    assert.equal(admissionOf(key, row()).eligible, false, key);
  }
  const annotated = annotateEvaluation(result("artificial-analysis", [row()]));
  assert.equal(annotated.rows[0]!.configuration.ineligible, null, "reference rows still have a representative for display");
});

test("LiveBench coding preserves its direct and controlled-tool parts; private prompts do not disqualify Mystery", () => {
  const a = admissionOf("livebench-coding", row());
  assert.equal(a.eligible, true);
  assert.equal(a.mode, "MIXED_FIXED_SINGLE_MODEL");
  const r = annotateEvaluation(result("livebench-coding", [{ ...row(), metadata: {
    release: "2026-06-25", "livebenchCategoryScore:Coding": 77, "livebenchCategoryScore:Agentic Coding": 65,
  } }])).rows[0]!;
  assert.equal(r.metadata!["livebenchCategoryScore:Coding"], 77);
  assert.equal(r.metadata!["livebenchCategoryScore:Agentic Coding"], 65);
  const mystery = admissionOf("epoch-mystery", row());
  assert.equal(mystery.eligible, true);
  assert.equal(mystery.mode, "TOOLS");
});

test("only a real Epoch run start becomes measuredAt; publication dates do not", () => {
  const sourcePublishedAt = "2026-09-23T17:14:01Z";
  const epoch = annotateEvaluation(result("epoch-gpqa", [{ ...row(), sourcePublishedAt, metadata: { runId: "run-7" } }]));
  assert.equal(epoch.rows[0]!.metadata!.measuredAt, sourcePublishedAt);
  assert.equal(epoch.rows[0]!.metadata!.runId, "run-7");
  for (const key of ["mercor-apex-agents", "eq-creative", "arena-vision"]) {
    const r = annotateEvaluation(result(key, [{ ...row(), sourcePublishedAt }])).rows[0]!;
    assert.equal(r.metadata!.measuredAt, undefined, key);
  }
});

test("typed sample metadata does not confuse votes, attempts and unique tasks", () => {
  const deep = annotateEvaluation(result("deepswe-v1-1", [{ ...row(), sampleSize: 339, metadata: { taskCount: 113, runCount: 3 } }]));
  assert.deepEqual(deep.rows[0]!.metadata!.sample, { unit: "tasks", uniqueItems: 113, attempts: 339, runs: 3 });
  const arena = annotateEvaluation(result("arena-vision", [{ ...row(), sampleSize: 20000 }]));
  assert.deepEqual(arena.rows[0]!.metadata!.sample, { unit: "votes", votes: 20000 });
  const epoch = annotateEvaluation(result("epoch-gpqa", [row()]));
  assert.equal(epoch.rows[0]!.metadata!.sample, undefined, "do not infer a per-run sample count from benchmark size");
});

test("annotation inherits snapshot versions, preserves raw values and bars row exceptions before representative selection", () => {
  const raw = result("vals-finance-agent", [row("anthropic/claude-opus-5"), row("anthropic/claude-opus-5-5")], { benchmarkVersion: "2" });
  const annotated = annotateEvaluation(raw);
  assert.equal(raw.rows[0]!.configuration.ineligible, null, "input is not mutated");
  assert.match(annotated.rows[0]!.configuration.ineligible!, /回退/);
  assert.equal(annotated.rows[1]!.configuration.ineligible, null);
  assert.equal(annotated.rows[1]!.rawScore, raw.rows[1]!.rawScore);
  assert.equal(annotated.rows[1]!.configuration.rank, raw.rows[1]!.configuration.rank);
  assert.equal((annotated.rows[1]!.metadata!.evaluation as { version: string }).version, "2");
  const protocol = annotated.metadata.evaluation as { protocolId: string; version: string };
  assert.equal(protocol.protocolId, "vals:finance-agent-v2");
  assert.equal(protocol.version, "2");
  const unversioned = annotateEvaluation(result("epoch-chess", [row()]));
  assert.equal(Object.hasOwn(unversioned.metadata.evaluation as object, "version"), true);
  assert.equal((unversioned.metadata.evaluation as { version: null }).version, null);
  for (const version of ["retired-version", null]) {
    const prior = { ...raw, metadata: { evaluation: { protocolId: "vals:finance-agent-v2", version } } };
    const next = annotateEvaluation(prior);
    assert.equal((next.metadata.evaluation as { version: unknown }).version, version, "an explicit historical version, including unknown, cannot become the current default");
    assert.equal(admissionOf(prior.sourceKey, { ...prior.rows[1]!, metadata: prior.metadata }).eligible, false);
    assert.equal(admissionOf(next.sourceKey, { ...next.rows[1]!, metadata: { ...next.metadata, ...next.rows[1]!.metadata } }).eligible, false);
  }
});
