import { Worker } from "node:worker_threads";
import type { BoardInput, BoardOutput } from "./consensus.ts";

export interface ComputedBoards {
  outputs: BoardOutput[];
  timings: Array<{ board: string; models: number; optimal: boolean; ms: number }>;
}

/** Keep the synchronous HiGHS solver off the queue/heartbeat event loop. Boards still run in their
 * original order, with the frozen protocol inputs, solver limits and tie policy, in one bounded worker. */
export function computeBoardsInWorker(boards: BoardInput[], options: { timeoutMs?: number } = {}): Promise<ComputedBoards> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./compute-worker.ts", import.meta.url), { workerData: boards });
    let result: ComputedBoards | undefined;
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Leaderboard computation deadline exceeded"));
    }, options.timeoutMs ?? 600_000);
    worker.once("message", (value: ComputedBoards) => { result = value; });
    worker.once("error", (error) => { clearTimeout(timeout); reject(error); });
    worker.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Leaderboard computation worker exited with code ${code}`));
      else if (!result) reject(new Error("Leaderboard computation worker exited without a result"));
      else resolve(result);
    });
  });
}
