// The MCP tool names, from the site's prefix (industry/site.ts): llms.txt, the agent page and the server
// list the same names. One tool per ability of /api/v1/agent.
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
} as const;

/** The tools the server offers, in the order it lists them. */
export const MCP_TOOLS = Object.values(MCP_TOOL_NAMES).map((name) => ({ name }));
