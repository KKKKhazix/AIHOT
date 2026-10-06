// Runs the production web server (apps/web/server.ts, after `npm run build -w @aihot/web`) in front of
// a synthetic api, for tests that read pages over HTTP or in a browser.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export interface WebServer {
  origin: string;
  port: number;
  /** What the server wrote to stderr so far: its error lines. */
  logs: () => string;
  /** Stops the web server and the api. */
  stop: () => Promise<void>;
}

/** Starts `api` and a web server that reads it. `env` adds to or overrides the web server's environment. */
export async function startWebServer(api: Server, env: NodeJS.ProcessEnv = {}): Promise<WebServer> {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  // The port is chosen first so the pages' canonical addresses (SITE_URL) name the server they come from.
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  let logs = "";
  const web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_PORT: String(port), SITE_URL: origin, TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async () => {
    if (web.exitCode === null) {
      web.kill("SIGTERM");
      await once(web, "exit");
    }
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
      web.once("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
      web.stderr!.on("data", (chunk) => { logs += String(chunk); });
      web.stdout!.on("data", (chunk) => {
        if (String(chunk).includes('"msg":"web started"')) { clearTimeout(timeout); resolve(); }
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin, port, logs: () => logs, stop };
}
