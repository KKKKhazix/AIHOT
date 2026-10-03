// The MCP tool names, from the site's prefix (site/site.ts): llms.txt, the agent page and the server
// list the same names. One tool per ability of /api/v1/agent; a module's tools follow the engine's.
import { SITE } from "@aihot/site";

/** A tool's full name: the site's prefix, then what it does ("get_latest"). */
export const mcpToolName = (tool: string): string => `${SITE.mcpPrefix}_${tool}`;

export const MCP_TOOL_NAMES = {
  latest: mcpToolName("get_latest"),
  search: mcpToolName("search"),
  hot: mcpToolName("get_hot_topics"),
  story: mcpToolName("get_story"),
  daily: mcpToolName("get_daily"),
  weekly: mcpToolName("get_weekly"),
  monthly: mcpToolName("get_monthly"),
} as const;

/** The engine's tools, in the order the server lists them. */
export const MCP_TOOLS = Object.values(MCP_TOOL_NAMES).map((name) => ({ name }));
