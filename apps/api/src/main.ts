import { assertProductionSecrets, config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { installModules, serverModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { feishuLoginConfigured } from "@aihot/backend/admin/auth";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { startWorkerWatchdog } from "@aihot/backend/operations/watch";
import { buildApp } from "./app.ts";

installModules(SERVER_MODULES);
assertProductionSecrets([
  ["auth", "SESSION_SECRET"],
  ["auth", "IMG_PROXY_SIGN_SECRET"],
  ...serverModules().flatMap((m) => m.secrets ?? []),
]);
// Somebody must be able to sign in to the admin.
if (config.environmentName === "production" && !(config.adminPassword && config.adminPassword.length >= 12) && !feishuLoginConfigured()) {
  throw new Error("Refusing to start in production: set ADMIN_PASSWORD (at least 12 characters) or configure Feishu sign-in");
}

const app = await buildApp();
await app.listen({ port: config.apiPort, host: process.env.API_HOST || "127.0.0.1" });
startHeartbeat(`api:${config.apiPort}`);
startWorkerWatchdog();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  for (const m of serverModules()) await m.stop?.().catch(() => {});
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
