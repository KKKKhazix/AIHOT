// Weighted incomplete Kemeny ordering as an integer program (HiGHS).
// y(i,j), i<j, is 1 when model i ranks above j. Minimising Σ reversed net support equals
// Σ max(0, M_ij) − Σ y(i,j)·M_ij; transitivity (triangle) constraints are added lazily until
// the incumbent is a total order.
import highsModule, { type Highs } from "highs";

// The package's typings describe its CommonJS face; under ESM the default import is the loader itself.
type Loader = (typeof import("highs"))["default"];
const loadHighs = ((highsModule as unknown as { default?: Loader }).default ?? highsModule) as Loader;

let highsPromise: Promise<Highs> | null = null;

export function highsRuntime(): Promise<Highs> {
  if (!highsPromise) highsPromise = loadHighs();
  return highsPromise;
}

export interface KemenyOptions {
  /**
   * Tie policy: among all orders with the optimal cost, return the one closest to `prefer`
   * (fewest pairwise disagreements). Without it the solver's own optimum is returned.
   */
  prefer?: number[] | null;
  timeLimitSeconds?: number;
}

export interface KemenyResult {
  order: number[];
  /** Σ net support reversed by `order`, summed exactly from the matrix. */
  cost: number;
  /** Solver's dual bound for the primary problem. */
  lowerBound: number;
  /** Certified by the numeric solver, within floating-point and solver feasibility tolerances. */
  optimal: boolean;
  /** Nominal solver tolerance rescaled to support units; not a statistical uncertainty bound. */
  numericalTolerance: number;
}

/** Σ over ordered pairs of the net support the order reverses. */
export function reversalCost(M: Float64Array[], order: number[]): number {
  let s = 0;
  for (let a = 0; a < order.length; a++) {
    const row = M[order[a]!]!;
    for (let b = a + 1; b < order.length; b++) {
      const m = row[order[b]!]!;
      if (m < 0) s -= m;
    }
  }
  return s;
}

export async function solveKemeny(M: Float64Array[], opts: KemenyOptions = {}): Promise<KemenyResult> {
  const n = M.length;
  if (n <= 1) return { order: n ? [0] : [], cost: 0, lowerBound: 0, optimal: true, numericalTolerance: 0 };
  const highs = await highsRuntime();
  const col = (i: number, j: number) => i * n - (i * (i + 1)) / 2 + (j - i - 1);
  const nv = (n * (n - 1)) / 2;
  let maxSupport = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) maxSupport = Math.max(maxSupport, Math.abs(M[i]![j]!));
  // A uniformly tiny continuous margin still contains a real ordering. Normalise the optimisation
  // objective only, preserving relative support and returning all costs in the original units.
  const objectiveScale = maxSupport || 1;
  const solverTolerance = 1e-9;
  let constant = 0;
  const cost = new Float64Array(nv);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const m = M[i]![j]! / objectiveScale;
      if (m > 0) constant += m;
      cost[col(i, j)] = -m;
    }
  }
  const model = highs.createModel({
    numCols: nv,
    numRows: 0,
    colCost: cost,
    colLower: new Float64Array(nv),
    colUpper: new Float64Array(nv).fill(1),
    rowLower: [],
    rowUpper: [],
    matrix: { format: "csr", numRows: 0, numCols: nv, starts: [0], indices: [], values: [] },
    integrality: new Int32Array(nv).fill(highs.constants.variableType.integer),
  } as never);
  try {
    model.options.set({ output_flag: false, mip_rel_gap: 0, mip_abs_gap: 0, random_seed: 0, mip_feasibility_tolerance: solverTolerance, primal_feasibility_tolerance: solverTolerance, dual_feasibility_tolerance: solverTolerance, time_limit: opts.timeLimitSeconds ?? 300 });
    const added = new Set<number>();
    const addTriangle = (i: number, j: number, k: number, positive: boolean) => {
      const key = ((i * n + j) * n + k) * 2 + (positive ? 1 : 0);
      if (added.has(key)) return false;
      added.add(key);
      const indices = [col(i, j), col(j, k), col(i, k)];
      // i>j & j>k ⇒ i>k   and   j>i & k>j ⇒ k>i
      model.addRow(-highs.infinity, positive ? 1 : 0, { indices, values: positive ? [1, 1, -1] : [-1, -1, 1] });
      return true;
    };
    const solveTransitive = (): { order: number[]; optimal: boolean } => {
      let optimal = true;
      for (;;) {
        model.run();
        if (model.getModelStatus() !== highs.constants.modelStatus.optimal) optimal = false;
        const x = model.getSolution().colValue;
        const y = (i: number, j: number) => (x[col(i, j)]! > 0.5 ? 1 : 0);
        let violations = 0;
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const a = y(i, j);
            for (let k = j + 1; k < n; k++) {
              const b = y(j, k);
              const c = y(i, k);
              if (a + b - c > 1) violations += addTriangle(i, j, k, true) ? 1 : 0;
              else if (c - a - b > 0) violations += addTriangle(i, j, k, false) ? 1 : 0;
            }
          }
        }
        if (violations === 0 || !optimal) {
          const wins = new Array<number>(n).fill(0);
          for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) wins[y(i, j) ? i : j]! += 1;
          return { order: [...Array(n).keys()].sort((p, q) => wins[q]! - wins[p]!), optimal: optimal && violations === 0 };
        }
      }
    };
    const first = solveTransitive();
    const lowerBound = (Number(model.info.get("mip_dual_bound")) + constant) * objectiveScale;
    let order = first.order;
    const best = reversalCost(M, order);
    if (opts.prefer && first.optimal) {
      // Second stage: keep the optimal cost, minimise disagreement with the preferred order.
      // The cost row subtracts sums, so allow floating-point accumulation error. A continuous
      // margin can be arbitrarily small: independently recheck the actual returned cost before
      // accepting the tie-break, instead of treating an absolute 1e-9 support gap as a tie.
      const pos = new Array<number>(n);
      opts.prefer.forEach((m, p) => (pos[m] = p));
      const indices: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          indices.push(col(i, j));
          values.push(-M[i]![j]! / objectiveScale);
          model.changeColCost(col(i, j), pos[i]! < pos[j]! ? -1 : 1);
        }
      }
      const slack = Number.EPSILON * nv * 4 * (Math.abs(best / objectiveScale) + constant);
      model.addRow(-highs.infinity, best / objectiveScale - constant + slack, { indices, values });
      const second = solveTransitive();
      const secondCost = reversalCost(M, second.order);
      const accumulationError = Number.EPSILON * nv * 4 * Math.max(Math.abs(best), Math.abs(secondCost));
      if (second.optimal && secondCost <= best + accumulationError) order = second.order;
    }
    return { order, cost: reversalCost(M, order), lowerBound, optimal: first.optimal, numericalTolerance: maxSupport * (solverTolerance + Number.EPSILON * nv * 4) };
  } finally {
    model.dispose();
  }
}
