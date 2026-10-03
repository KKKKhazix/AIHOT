// Pure computation only: this thread never opens a database or calls a provider.
import { parentPort, workerData } from "node:worker_threads";
import { computeBoard, type BoardInput } from "./consensus.ts";
import type { ComputedBoards } from "./compute.ts";

const boards = workerData as BoardInput[];
const result: ComputedBoards = { outputs: [], timings: [] };
for (const input of boards) {
  const started = Date.now();
  const output = await computeBoard(input);
  result.outputs.push(output);
  result.timings.push({ board: input.board, models: input.models.length, optimal: output.solver.optimal, ms: Date.now() - started });
}
parentPort!.postMessage(result);
parentPort!.close();
