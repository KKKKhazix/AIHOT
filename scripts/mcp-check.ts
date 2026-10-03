// Verifies the public MCP contract with the official SDK client: server identity, the exact tool set,
// representative read calls, domain errors and schema validation. It is safe against an empty database.
// node scripts/mcp-check.ts [url]
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { MCP_TOOL_NAMES as T, MCP_TOOLS } from "@aihot/contracts/mcp";
import { FEATURES } from "@aihot/industry/features";
import { SITE } from "@aihot/industry/site";

const url = new URL(process.argv[2] ?? "http://127.0.0.1:3001/api/mcp");
const client = new Client({ name: `${SITE.mcpPrefix}-mcp-check`, version: "1.0.0" });

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
}

function errorCode(result: Awaited<ReturnType<Client["callTool"]>>): string | null {
  const structured = result.structuredContent as { error?: { code?: unknown } } | undefined;
  return typeof structured?.error?.code === "string" ? structured.error.code : null;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  expect: { error?: boolean; code?: string } = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const text = firstText(result).replace(/\n/g, " ").slice(0, 140);
  const gotError = result.isError === true;
  console.log(`${name} ${JSON.stringify(args)} → ${gotError ? "ERROR" : "ok"} | ${text}`);
  if (gotError !== (expect.error ?? false)) {
    throw new Error(`${name} expected ${expect.error ? "an error" : "success"}, got ${gotError ? "an error" : "success"}`);
  }
  if (expect.code && errorCode(result) !== expect.code) {
    throw new Error(`${name} expected error code ${expect.code}, got ${errorCode(result) ?? "(none)"}`);
  }
  return result;
}

await client.connect(new StreamableHTTPClientTransport(url));
try {
  const info = client.getServerVersion?.();
  console.log("server:", JSON.stringify(info));
  if (info?.name !== SITE.mcpPrefix) {
    throw new Error(`server name mismatch: expected ${SITE.mcpPrefix}, got ${info?.name ?? "(missing)"}`);
  }
  if (info?.version !== PUBLIC_INTERFACE_VERSION) {
    throw new Error(`server version mismatch: expected ${PUBLIC_INTERFACE_VERSION}, got ${info?.version ?? "(missing)"}`);
  }

  const listed = await client.listTools();
  const actualNames = listed.tools.map((tool) => tool.name).sort();
  const expectedNames = MCP_TOOLS.map((tool) => tool.name).sort();
  console.log("tools:", actualNames.join(", "));
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`tool list mismatch: expected [${expectedNames.join(", ")}], got [${actualNames.join(", ")}]`);
  }

  // These reads are valid on a fresh site: an empty result set is still a successful public answer.
  await call(T.latest, { limit: 2 });
  await call(T.search, { q: "OpenAI", limit: 2 });
  await call(T.hot, { limit: 3 });
  if (FEATURES.codexResetMonitor) await call(T.codexResets, {});

  // Exercise the remaining tools without depending on seeded reports/stories.
  await call(T.daily, { date: "2026-02-30" }, { error: true, code: "invalid_request" });
  await call(T.weekly, { week: "2026-W54" }, { error: true, code: "invalid_request" });
  await call(T.monthly, { month: "2026-13" }, { error: true, code: "invalid_request" });
  await call(T.story, { public_id: "__mcp_check_missing__", report_limit: 3 }, { error: true, code: "not_found" });

  // SDK/server schema validation must reject values outside the advertised input contract.
  await call(T.latest, { limit: 99 }, { error: true });

  console.log("MCP contract check passed");
} finally {
  await client.close();
}
