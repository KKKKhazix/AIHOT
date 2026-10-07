// A module can require arguments without an empty-site sample. Discovery is always checked, and
// declared samples remain real SDK calls: invalid arguments, failed reads and missing tools fail.
import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import Fastify from "fastify";
import { z } from "zod";
import { closeDb } from "@aihot/backend/db";
import { installModules, type AgentAbility } from "@aihot/backend/modules";
import { mcpToolName } from "@aihot/contracts/mcp";
import { registerMcp } from "../apps/api/src/routes/mcp.ts";

function asyncInput(acceptEmpty: boolean) {
  return z.strictObject({ id: z.string().optional() }).refine(async ({ id }) => acceptEmpty || id !== undefined);
}

test("the MCP check uses module samples and keeps its failure assertions", async (t) => {
  const calls: Record<string, unknown>[] = [];
  const abilities: AgentAbility[] = [
    {
      path: "/echo-check", title: "echo", ask: "echo", answer: async () => "echo", etagPrefix: "echo", cacheControl: "no-store",
      mcp: {
        tool: "echo_check", use: "for tests", description: "Echo a required label.",
        input: z.strictObject({ label: z.string().min(2) }), checkArgs: { label: "sample" },
        run: async (args) => {
          calls.push(args);
          if (args.label === "fail") throw new Error("fixture read failed");
          return { text: String(args.label), structured: { label: args.label } };
        },
      },
    },
    {
      path: "/status-check", title: "status", ask: "status", answer: async () => "ok", etagPrefix: "status", cacheControl: "no-store",
      mcp: {
        tool: "status_check", use: "for tests", description: "An async input accepting empty arguments.", input: asyncInput(true),
        run: async (args) => { calls.push(args); return { text: "ok", structured: { status: "ok" } }; },
      },
    },
    {
      path: "/async-check", title: "async", ask: "async", answer: async () => "ok", etagPrefix: "async", cacheControl: "no-store",
      mcp: {
        tool: "async_check", use: "for tests", description: "An async input requiring an id.", input: asyncInput(false),
        run: async (args) => { calls.push(args); return { text: "ok", structured: { id: args.id } }; },
      },
    },
  ];
  installModules([{ name: "check-fixture", agent: { abilities } }]);
  const app = Fastify();
  const requestedTools: string[] = [];
  app.addHook("preHandler", async (req) => {
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    if (body?.method === "tools/call") requestedTools.push(body.params?.name ?? "");
  });
  registerMcp(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const samples = abilities.map(({ mcp }) => ({ tool: mcp.tool, checkArgs: mcp.checkArgs, input: z.toJSONSchema(mcp.input, { io: "input" }) }));

  // Only replace the child process's site manifest. The CLI, SDK, HTTP route and public reads are
  // unchanged, and use this file's empty test database; no real site module is needed for the fixture.
  function check(tools = samples) {
    const manifest = [{ name: "check-fixture", agent: { abilities: tools.map((mcp) => ({ mcp })) } }];
    const source = `
      import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
      const asyncInput = ${asyncInput.toString()};
      export const SERVER_MODULES = ${JSON.stringify(manifest)};
      for (const module of SERVER_MODULES) for (const ability of module.agent.abilities) {
        // JSON Schema cannot carry refinements: use the same async schemas as the server.
        ability.mcp.input = ability.mcp.tool === "status_check" ? asyncInput(true)
          : ability.mcp.tool === "async_check" ? asyncInput(false) : z.fromJSONSchema(ability.mcp.input);
      }
    `;
    const preload = `
      import { registerHooks } from "node:module";
      const manifestUrl = ${JSON.stringify(import.meta.resolve("@aihot/site/modules/server"))};
      registerHooks({ load(url, context, next) {
        return url === manifestUrl ? { format: "module", source: ${JSON.stringify(source)}, shortCircuit: true } : next(url, context);
      } });
    `;
    return promisify(execFile)(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "scripts/mcp-check.ts", `${address}/api/mcp`], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15000,
    });
  }

  async function fails(tools: typeof samples, message: RegExp) {
    await assert.rejects(check(tools), (error: unknown) => {
      const result = error as Error & { code: number; stdout: string };
      assert.notEqual(result.code, 0);
      assert.match(result.stdout + result.message, message);
      return true;
    });
  }

  try {
    await t.test("a required sample and the default empty arguments both succeed", async () => {
      assert.match((await check()).stdout, /MCP contract check passed/);
      assert.deepEqual(calls, [{ label: "sample" }, {}]);
    });
    await t.test("a required tool without a sample is discovered without a false failure", async () => {
      const before = requestedTools.length;
      const result = await check(samples.map((sample) => ({ ...sample, checkArgs: undefined })));
      assert.match(result.stdout, /echo_check → discovery only/);
      assert.match(result.stdout, /MCP contract check passed/);
      const moduleCalls = requestedTools.slice(before).filter((name) => samples.some((sample) => name === mcpToolName(sample.tool)));
      assert.deepEqual(moduleCalls, [mcpToolName("status_check")]);
    });
    await t.test("async input validation decides empty calls and preserves explicit samples", async () => {
      const before = requestedTools.length;
      const result = await check();
      assert.match(result.stdout, /status_check \{\} → ok/);
      assert.match(result.stdout, /async_check → discovery only/);
      const moduleCalls = requestedTools.slice(before).filter((name) => samples.some((sample) => name === mcpToolName(sample.tool)));
      assert.deepEqual(moduleCalls, [mcpToolName("echo_check"), mcpToolName("status_check")]);
      assert.match((await check([samples[0], samples[1], { ...samples[2], checkArgs: { id: "sample" } }])).stdout, /async_check \{"id":"sample"\} → ok/);
      assert.deepEqual(calls.at(-1), { id: "sample" });
    });
    await t.test("an explicit invalid sample still fails SDK validation", async () => {
      await fails([{ ...samples[0], checkArgs: {} }, samples[1], samples[2]], /expected success, got an error/);
    });
    await t.test("schema-valid arguments do not excuse a failed read", async () => {
      await fails([{ ...samples[0], checkArgs: { label: "fail" } }, samples[1], samples[2]], /expected success, got an error/);
    });
    await t.test("every declared module tool must be listed", async () => {
      await fails([...samples, { ...samples[0], tool: "missing_check", checkArgs: undefined }], /tool list mismatch/);
    });
  } finally {
    app.server.closeAllConnections();
    await app.close();
    installModules([]);
    await closeDb();
  }
});
