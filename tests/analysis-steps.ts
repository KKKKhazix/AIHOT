// Which step of the article analysis a model request is for, and a score that selects. Each step sends
// its own system prompt, rendered from the industry pack, and the thresholds come from the pack too: a
// test that recognises a request by its whole prompt and scores against the pack's threshold keeps
// working when a site rewrites the prompts and recalibrates the thresholds for its own industry.
import { SCORE_SYSTEM, STRUCTURE_SYSTEM, tierThreshold } from "@aihot/backend/editorial/analyze";
import { PREFILTER_SYSTEM, UNDERSTAND_SYSTEM } from "@aihot/backend/editorial/writing";

export type AnalysisStep = "prefilter" | "score" | "structure" | "understand" | "summarize";

const BY_SYSTEM = new Map<string, AnalysisStep>([
  [PREFILTER_SYSTEM, "prefilter"], [SCORE_SYSTEM, "score"], [STRUCTURE_SYSTEM, "structure"], [UNDERSTAND_SYSTEM, "understand"],
]);

/** The step of a chat request, from its body as the provider receives it; the title/summary prompt comes without a system message. */
export function analysisStep(body: string): AnalysisStep {
  const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
  if (messages[0]?.role !== "system") return "summarize";
  const step = BY_SYSTEM.get(String(messages[0].content));
  if (!step) throw new Error(`not a request of the article analysis: ${String(messages[0].content).slice(0, 80)}`);
  return step;
}

/** Both score calls at the T1 threshold: material from a T1 source is selected, with this mean score. */
export const SELECTING_SCORE = tierThreshold("T1")!;
