// The MCP tool names, from the site's prefix (industry/site.ts): llms.txt, the agent page and the server
// list the same names. One tool per ability of /api/v1/agent.
import { FEATURES } from "@aihot/industry/features";
import { SITE } from "@aihot/industry/site";

const p = SITE.mcpPrefix;

export const MCP_TOOL_NAMES = {
  latest: `${p}_get_latest`,
  search: `${p}_search`,
  hot: `${p}_get_hot_topics`,
  story: `${p}_get_story`,
  daily: `${p}_get_daily`,
  weekly: `${p}_get_weekly`,
  monthly: `${p}_get_monthly`,
  codexResets: `${p}_get_codex_resets`,
} as const;

/** The tools the server offers: the Codex reset tool only with its module (industry/features.ts). */
export const MCP_TOOLS = Object.entries(MCP_TOOL_NAMES)
  .filter(([key]) => key !== "codexResets" || FEATURES.codexResetMonitor)
  .map(([, name]) => ({ name }));
