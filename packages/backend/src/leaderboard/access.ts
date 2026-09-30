import type { LbBoardEntry } from "@aihot/contracts/leaderboard";
import weights from "./model-weights.json" with { type: "json" };
import { BOARD_LIMIT } from "./registry.ts";

// This describes the developer, not the reader's network, account or an API reseller.
const DOMESTIC_PROVIDERS = new Set(["alibaba", "deepseek", "moonshot", "xiaomi", "z-ai", "minimax", "baidu", "tencent", "bytedance", "stepfun", "meituan", "inclusionai", "ant-group", "china-mobile", "kuaishou"]);
const DOMESTIC_NAMES = new Set(["alibaba", "deepseek", "moonshot ai", "xiaomi", "z.ai", "minimax", "baidu", "tencent", "bytedance", "stepfun", "meituan", "inclusionai", "ant-group", "china mobile", "kuaishou"]);

export function modelAccess(model: { slug: string; provider_slug: string | null; provider: string | null }): LbBoardEntry["access"] {
  const repository = (weights.models as Record<string, string>)[model.slug];
  return {
    domestic: DOMESTIC_PROVIDERS.has(model.provider_slug ?? "") || DOMESTIC_NAMES.has(model.provider?.trim().toLowerCase() ?? ""),
    weightsUrl: repository ? `https://huggingface.co/${repository}` : null,
  };
}

/** Filter the existing ranking before taking 30; no recomputation or renumbering. */
export function boardSubset<T extends { rank: number; access: LbBoardEntry["access"] }>(entries: T[], domestic = false, openWeights = false): T[] {
  return entries.filter((e) => (!domestic || e.access.domestic) && (!openWeights || !!e.access.weightsUrl)).slice(0, BOARD_LIMIT);
}
