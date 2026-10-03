// Geometry shared by the heat charts: hourly values split into runs at unobserved hours, each run drawn
// as a monotone curve, which bends smoothly but never overshoots a reading (no peak above the real
// peak, no dip below zero), so the smoothing changes the look and not the numbers. Unobserved hours
// are never drawn: the curve and its wash stop at them.

export type Pt = readonly [x: number, y: number];

/** Runs of consecutive observed values, as their indexes; an unobserved hour (null) ends a run. */
export function observedRuns(values: ReadonlyArray<number | null>): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((v, i) => {
    if (v !== null) run.push(i);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);
  return runs;
}

const f = (n: number) => +n.toFixed(2);

/** Monotone cubic through the points (Fritsch–Carlson tangents). One point is a dot for a round cap. */
export function curvePath(pts: readonly Pt[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${f(pts[0]![0])} ${f(pts[0]![1])}h0`;
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) slope.push((pts[i + 1]![1] - pts[i]![1]) / (pts[i + 1]![0] - pts[i]![0] || 1));
  const tangent = pts.map((_, i) => {
    if (i === 0) return slope[0]!;
    if (i === n - 1) return slope[n - 2]!;
    const a = slope[i - 1]!;
    const b = slope[i]!;
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = (x1 - x0) / 3;
    d += `C${f(x0 + h)} ${f(y0 + tangent[i]! * h)} ${f(x1 - h)} ${f(y1 - tangent[i + 1]! * h)} ${f(x1)} ${f(y1)}`;
  }
  return d;
}

/** The curve closed down to the baseline, for the wash under it; nothing for a single point. */
export function areaPath(pts: readonly Pt[], base: number): string {
  if (pts.length < 2) return "";
  return `${curvePath(pts)}L${f(pts[pts.length - 1]![0])} ${f(base)}L${f(pts[0]![0])} ${f(base)}Z`;
}
