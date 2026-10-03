// A protocol-bound reference scale. Building it is pure; callers persist the first accepted result
// and reuse it, so changes to the current candidate cohort never silently recalibrate a benchmark.
import { createHash } from "node:crypto";

// Adding a display score does not reset existing measurement scales. This identifies their
// original freeze generation; change it only when the measurement calibration policy changes.
export const CALIBRATION_METHOD_VERSION = "2026.10-observed-evidence-v16";
export const CALIBRATION_VERSION = "2026.10-fixed-anchor-iqr-v1";
export const ANCHORS = [
  "claude-fable-5", "gpt-5-6-sol", "kimi-k-3", "qwen-3-8-max", "gpt-5-4", "claude-opus-4-8", "claude-sonnet-5", "grok-4-5", "gemini-3-5-flash",
  "glm-5-2", "claude-sonnet-4-6", "qwen-3-7-max", "kimi-k-2-6", "deepseek-v-4-pro", "qwen-3-6-plus", "minimax-m-3", "gpt-5-4-mini", "grok-4-3",
];

export interface Calibration {
  protocol: string;
  version: string;
  scale: number;
  anchors: Array<{ slug: string; score: number; configuration?: string; snapshotId?: string }>;
  q25: number;
  q50: number;
  q75: number;
  digest: string;
}

function quantile(sorted: number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const index = Math.floor(position);
  const fraction = position - index;
  return sorted[index]! * (1 - fraction) + sorted[Math.min(index + 1, sorted.length - 1)]! * fraction;
}

const digestOf = (c: Omit<Calibration, "digest">) => createHash("sha256").update(JSON.stringify({
  protocol: c.protocol, version: c.version, scale: c.scale,
  // JSONB can reorder object keys. Hash the declared evidence fields in a fixed order so a
  // persisted record retains its original digest without overlooking changed provenance.
  anchors: c.anchors.map((a) => ({ slug: a.slug, score: a.score, configuration: a.configuration, snapshotId: a.snapshotId })),
  q25: c.q25, q50: c.q50, q75: c.q75,
})).digest("hex");

export function buildCalibration(protocol: string, rows: ReadonlyArray<{ modelSlug: string; score: number; configuration?: string; snapshotId?: string }>, anchorSlugs: readonly string[] = ANCHORS): Calibration | null {
  if (!protocol) return null;
  const allowed = new Set(anchorSlugs);
  const scores = new Map<string, Calibration["anchors"][number]>();
  for (const row of rows) {
    if (!allowed.has(row.modelSlug) || !Number.isFinite(row.score)) continue;
    const previous = scores.get(row.modelSlug);
    if (previous && (previous.score !== row.score || previous.configuration !== row.configuration || previous.snapshotId !== row.snapshotId)) return null;
    scores.set(row.modelSlug, { slug: row.modelSlug, score: row.score,
      ...(row.configuration === undefined ? {} : { configuration: row.configuration }),
      ...(row.snapshotId === undefined ? {} : { snapshotId: row.snapshotId }),
    });
  }
  if (scores.size < 4) return null;
  const anchors = [...scores].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, anchor]) => anchor);
  const sorted = anchors.map((a) => a.score).sort((a, b) => a - b);
  const q25 = quantile(sorted, 0.25), q50 = quantile(sorted, 0.5), q75 = quantile(sorted, 0.75);
  const scale = q75 - q25;
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const record = { protocol, version: CALIBRATION_VERSION, scale, anchors, q25, q50, q75 };
  return { ...record, digest: digestOf(record) };
}

export function validCalibration(calibration: Calibration | null | undefined, protocol: string): calibration is Calibration {
  if (!calibration || calibration.protocol !== protocol || calibration.version !== CALIBRATION_VERSION || !Array.isArray(calibration.anchors)) return false;
  if (calibration.anchors.some((a) => !ANCHORS.includes(a.slug))) return false;
  const expected = buildCalibration(protocol, calibration.anchors.map((a) => ({ modelSlug: a.slug, score: a.score, configuration: a.configuration, snapshotId: a.snapshotId })));
  return expected !== null && expected.digest === calibration.digest && digestOf(calibration) === calibration.digest;
}
