// Failure contracts written before the v16 implementation: changing cohorts, tiny margins, changing
// units, unknown errors and disconnected comparisons must not invent certainty.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANCHORS, BUDGETS, SCORING_SOURCES, assignEvidenceWeights, buildCalibration, computeBoard, netMatrix, validCalibration,
  type BoardInput, type Calibration, type RegistryEntry, type ScoringSource, type SignalRow,
} from "@aihot/backend/leaderboard/method/consensus";
import { solveKemeny } from "@aihot/backend/leaderboard/method/kemeny";

const row = (modelSlug: string, score: number): SignalRow => ({ modelSlug, score, lowerBound: null, upperBound: null, configuration: "fixed" });
const calibration = (factor = 1): Calibration => buildCalibration("edition-1", ANCHORS.slice(0, 4).map((slug, i) => row(slug, i * factor)))!;
const registry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  sourceKey: "source-a", budget: "coding", family: "family-a", operator: "operator-a",
  protocol: "edition-1", weight: 0.125, direction: "HIGHER", interval_sd: null,
  calibration: calibration(), ...overrides,
});
const input = (): BoardInput => ({
  board: "overall", models: ["a", "b", "c", "d"], names: { a: "A", b: "B", c: "C", d: "D" },
  anchors: [...ANCHORS], policy: { sources: 3, operators: 3, families: 3, categories: 3, directAnchors: 2 },
  registry: { first: registry() },
  signals: [{ key: "first", rows: [row("a", 2), row("b", 1.8), row("c", 1.2), row("d", 1)] }],
});
const support = (x: BoardInput, a = "a", b = "b") => {
  const net = netMatrix(x);
  return net.M[net.index.get(a)!]![net.index.get(b)!]!;
};

test("calibration only uses the fixed references and is bound to one measurement protocol", () => {
  const refs = ANCHORS.slice(0, 4).map((slug, i) => row(slug, i));
  const a = buildCalibration("edition-1", refs)!;
  const b = buildCalibration("edition-1", [...refs].reverse().concat(row("new-model", 1e9)))!;
  assert.deepEqual(a, b);
  assert.equal(a.scale, 1.5);
  assert.equal(a.q25, 0.75);
  assert.equal(a.q50, 1.5);
  assert.equal(a.q75, 2.25);
  assert.ok(validCalibration(a, "edition-1"));
  assert.equal(validCalibration(a, "edition-2"), false);
  assert.equal(validCalibration({ ...a, scale: 10 }, "edition-1"), false, "a changed scale needs a new verified calibration");
  assert.equal(buildCalibration("edition-1", refs.slice(0, 3)), null);
  assert.equal(buildCalibration("edition-1", refs.map((r) => ({ ...r, score: 7 }))), null);
});

test("frozen calibration preserves each anchor configuration and snapshot and rejects altered provenance", () => {
  const refs = ANCHORS.slice(0, 4).map((slug, i) => ({ ...row(slug, i), snapshotId: `snapshot-${i}` }));
  const c = buildCalibration("edition-1", refs)!;
  const anchor = c.anchors.find((a) => a.slug === refs[0]!.modelSlug)!;
  assert.equal(anchor.configuration, "fixed");
  assert.equal(anchor.snapshotId, "snapshot-0");
  assert.ok(validCalibration(c, "edition-1"));
  assert.equal(validCalibration({ ...c, anchors: c.anchors.map((a) => ({ ...a, snapshotId: "replaced" })) }, "edition-1"), false);
  assert.equal(validCalibration({ ...c, anchors: c.anchors.map((a) => ({ ...a, configuration: "other" })) }, "edition-1"), false);
  assert.equal(buildCalibration("edition-1", [...refs, { ...refs[0]!, snapshotId: "conflicting-copy" }]), null);
});

test("calibration verification survives JSONB object-key reordering without changing the persisted digest", () => {
  const refs = ANCHORS.slice(0, 4).map((slug, i) => ({ ...row(slug, i), snapshotId: `snapshot-${i}` }));
  const original = buildCalibration("edition-1", refs)!;
  const reordered = Object.fromEntries(Object.entries({ ...original,
    anchors: original.anchors.map((a) => Object.fromEntries(Object.entries(a).reverse())),
  }).reverse());
  const restored = JSON.parse(JSON.stringify(reordered)) as Calibration;
  assert.notEqual(JSON.stringify(restored), JSON.stringify(original));
  assert.equal(restored.digest, original.digest);
  assert.ok(validCalibration(restored, "edition-1"));
  assert.equal(validCalibration({ ...restored, anchors: restored.anchors.map((a) => ({ ...a, snapshotId: "altered" })) }, "edition-1"), false);
});

test("domain and family shares stay fixed when a family gains a measurement", () => {
  const source = (unit: string, family: string): ScoringSource => ({
    key: unit, unit, family, budget: "coding", operator: unit, category: "coding",
    weight: 0, scoring: true, intervalSd: null, direction: "HIGHER",
  });
  const base = [source("a", "f1"), source("b", "f2")];
  const weights = assignEvidenceWeights(base);
  assert.equal(weights.get("a"), 0.0625);
  assert.equal(weights.get("b"), 0.0625);
  const expanded = assignEvidenceWeights([...base, source("c", "f1")]);
  assert.equal(expanded.get("a")! + expanded.get("c")!, weights.get("a"));
  assert.equal(expanded.get("b"), weights.get("b"));
});

test("capability budgets separate language from creative writing and do not count tools as a second professional domain", () => {
  assert.deepEqual(BUDGETS.map((b) => b.key).sort(), ["coding", "knowledge", "language", "multilingual", "professional", "reasoning", "vision", "writing"]);
  assert.ok(BUDGETS.every((b) => b.weight === 0.125));
  const source = (key: string) => SCORING_SOURCES.find((s) => s.key === key)!;
  assert.equal(source("livebench-writing").budget, "language");
  assert.equal(source("livebench-writing").weight, 0.125);
  assert.equal(source("mercor-apex-agents").budget, "professional");
  assert.equal(source("mercor-apex-agents").weight, 0.0625);
  assert.equal(source("vals-finance-agent").weight, 0.0625);
  assert.equal(source("tau-banking").budget, "professional");
  assert.equal(source("tau-banking").weight, 0);
  assert.equal(SCORING_SOURCES.filter((s) => s.budget === "writing").reduce((sum, s) => sum + s.weight, 0), 0.125);
});

test("task families follow distinct evidence tasks while related benchmark variants share a family budget", () => {
  const family = (unit: string) => SCORING_SOURCES.find((s) => s.unit === unit)!.family;
  assert.notEqual(family("mercor-apex-agents:loop-pass-1"), family("vals-finance-agent"));
  assert.notEqual(family("livebench-coding:direct"), family("livebench-coding:agentic"));
  assert.notEqual(family("livebench-reasoning"), family("livebench-writing"));
  assert.notEqual(family("arena-creative-writing"), family("arena-vision"));
  assert.notEqual(family("epoch-chess"), family("epoch-mystery"));
  assert.equal(family("epoch-frontiermath"), family("epoch-frontiermath-tier4"));
  assert.equal(family("eq-creative"), family("eq-longform"), "unverified independence retains the conservative shared creative-task budget");
});

test("two distinct measurements from one source do not claim two independent sources", async () => {
  const x = input();
  x.registry.second = registry();
  x.signals.push({ key: "second", rows: structuredClone(x.signals[0]!.rows) });
  const out = await computeBoard(x);
  assert.equal(out.source_count, 1);
  assert.equal(out.measurement_count, 2);
  assert.equal(out.entries[0]!.source_count, 1);
  assert.equal(out.entries[0]!.measurement_count, 2);
});

test("tiny raw differences create proportionally tiny support and zero difference stays a tie", () => {
  const x = input();
  x.signals[0]!.rows = [row("a", 1 + 1e-6), row("b", 1)];
  const first = support(x);
  x.signals[0]!.rows[0]!.score = 1 + 2e-6;
  assert.ok(Math.abs(support(x) - 2 * first) < 1e-15);
  assert.ok(first > 0 && first < 1e-6);
  x.signals[0]!.rows[0]!.score = 1;
  assert.equal(support(x), 0);
});

test("a tie preference cannot discard a genuine tiny continuous margin", async () => {
  for (const margin of [1e-9, 1e-12]) {
    const result = await solveKemeny([new Float64Array([0, -margin]), new Float64Array([margin, 0])], { prefer: [0, 1] });
    assert.deepEqual(result.order, [1, 0]);
    assert.equal(result.cost, 0);
    assert.ok(result.optimal);
    assert.ok(Number.isFinite(result.numericalTolerance) && result.numericalTolerance < margin);
  }
});

test("changing units and their frozen calibration together preserves every comparison", () => {
  const x = input(), converted = structuredClone(x);
  for (const r of converted.signals[0]!.rows) r.score *= 100;
  converted.registry.first!.calibration = calibration(100);
  assert.ok(Math.abs(support(x) - support(converted)) < 1e-15);
});

test("adding a new ordinary model never changes an existing pair's scale or vote weight", () => {
  const x = input(), expanded = structuredClone(x);
  expanded.models.push("new-model");
  expanded.signals[0]!.rows.push(row("new-model", -1e6));
  assert.equal(support(expanded), support(x));
});

test("missing or invalid calibration casts no comparisons and cannot connect a board", async () => {
  const x = input();
  x.registry.first!.calibration = null;
  const out = await computeBoard(x);
  assert.equal(out.observed_pair_count, 0);
  assert.equal(out.active_budget, 0);
  assert.equal(out.publishable_connectivity, false);
});

test("unknown errors remain explicit and a rating without reference anchors stays unavailable", async () => {
  const out = await computeBoard(input());
  assert.equal(out.unknown_error_count, 4);
  assert.equal(out.entries[0]!.unknownErrorCount, 1);
  assert.equal(out.entries[0]!.score, null);
  assert.equal(out.scoring.optimal, false);
  assert.ok(!("display" in out));
});

test("published bounds count as known errors without turning absent errors into measured precision", async () => {
  const x = input();
  x.registry.first!.interval_sd = 1.96;
  x.signals[0]!.rows[0]!.lowerBound = 0.5;
  x.signals[0]!.rows[0]!.upperBound = 3.5;
  const out = await computeBoard(x);
  assert.equal(out.unknown_error_count, 3);
  assert.equal(out.entries.find((e) => e.slug === "a")!.unknownErrorCount, 0);
  assert.equal(out.entries.find((e) => e.slug === "b")!.unknownErrorCount, 1);
});

test("two internally comparable islands cannot be published as one precise ranking", async () => {
  const x = input();
  x.signals[0]!.rows = [row("a", 2), row("b", 1)];
  x.registry.second = registry({ family: "family-b", operator: "operator-b" });
  x.signals.push({ key: "second", rows: [row("c", 2), row("d", 1)] });
  const out = await computeBoard(x);
  assert.equal(out.connected_components, 2);
  assert.equal(out.publishable_connectivity, false);
  assert.equal(out.observed_pair_count, 2);
});

test("row, signal and candidate input order cannot change a deterministic replay", async () => {
  const x = input();
  x.registry.second = registry({ family: "family-b", operator: "operator-b" });
  x.signals.push({ key: "second", rows: [row("a", 1), row("b", 1.1), row("c", 1.8), row("d", 2)] });
  const permuted = structuredClone(x);
  permuted.models.reverse();
  permuted.signals.reverse();
  for (const s of permuted.signals) s.rows.reverse();
  assert.deepEqual(await computeBoard(permuted), await computeBoard(x));
});

test("a genuine preference cycle reports its optimal conflict", async () => {
  const x = input();
  x.models = ["a", "b", "c"];
  x.registry = {};
  x.signals = [];
  for (const [index, [winner, loser]] of [["a", "b"], ["b", "c"], ["c", "a"]].entries()) {
    const key = `cycle-${index}`;
    x.registry[key] = registry({ sourceKey: key, operator: key, family: key, weight: 1 / 3 });
    x.signals.push({ key, rows: [row(winner!, 3), row(loser!, 0)] });
  }
  const out = await computeBoard(x);
  assert.ok(out.solver.optimal);
  assert.ok(Math.abs(out.solver.reversal_cost - 1 / 3) < 1e-10);
});

// Twice the families the registry has today (SCORING_SOURCES).
test("40 independent families with 100 models complete the reference order", async () => {
  const families = 40;
  const x = input();
  x.models = Array.from({ length: 100 }, (_, i) => `model-${String(i).padStart(3, "0")}`);
  x.names = Object.fromEntries(x.models.map((m) => [m, m]));
  x.registry = {};
  x.signals = [];
  for (let i = 0; i < families; i++) {
    const key = `independent-${i}`;
    x.registry[key] = registry({ sourceKey: key, operator: `operator-${i % 10}`, family: key, weight: 1 / families });
    x.signals.push({ key, rows: x.models.map((m, position) => row(m, (100 - position) / 100 + i / 1000)) });
  }
  const out = await computeBoard(x);
  assert.ok(out.solver.optimal);
  assert.equal(out.measurement_count, families);
  assert.equal(out.observed_pair_count, 4950);
  assert.deepEqual(out.entries.map((e) => e.slug), x.models);
});
