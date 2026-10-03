// Runtime configuration. Secrets are loaded per group (models, collectors, integrations, auth)
// from dotenv files, and only by the backend processes that need them.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { SITE } from "@aihot/industry/site";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const env = process.env;

function str(name: string, fallback?: string): string {
  const value = env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function int(name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export const isProduction = env.NODE_ENV === "production";

export const config = {
  databaseUrl: str("DATABASE_URL", "postgres://127.0.0.1:5432/aihot"),
  apiPort: int("API_PORT", 3001),
  // Every generated absolute link uses this address, whatever Host a request arrives with.
  siteUrl: str("SITE_URL", SITE.defaultUrl).replace(/\/+$/, ""),
  egressProxyUrl: env.EGRESS_PROXY_URL || null,
  allowPrivateNetworkFetch: bool("ALLOW_PRIVATE_NETWORK_FETCH", false),
  feishuContentPushEnabled: bool("FEISHU_CONTENT_PUSH_ENABLED", false),
  indexNowSubmitEnabled: bool("INDEXNOW_SUBMIT_ENABLED", false),
  /** IndexNow key (32 hex characters); without one nothing is submitted and no key file is served. */
  indexNowKey: /^[0-9a-f]{32}$/.test(env.INDEXNOW_KEY ?? "") ? env.INDEXNOW_KEY! : null,
  /** Optional directory of per-group dotenv files (models.env, collectors.env, …); normally everything is in .env. */
  credentialsDir: env.AIHOT_CREDENTIALS_DIR || null,
  dataDir: str("AIHOT_DATA_DIR", path.join(REPO_ROOT, ".data")),
  // Name of this deployment in alerts ("production" sends them without a prefix).
  environmentName: str("AIHOT_ENVIRONMENT", isProduction ? "production" : "development"),
  // External-action valve: off unless the environment turns it on, like COLLECT_ENABLED (read by the
  // worker). .env.example turns both on.
  modelCallsEnabled: bool("MODEL_CALLS_ENABLED", false),
  devAdmin: env.DEV_AUTH_ROLE === "admin" ? { displayName: env.DEV_AUTH_DISPLAY_NAME || "Dev Admin" } : null,
  /** The admin password (at least 12 characters). Feishu sign-in below is optional. */
  adminPassword: env.ADMIN_PASSWORD || null,
  adminUnionIds: (env.ADMIN_FEISHU_UNION_IDS || "").split(",").map((v) => v.trim()).filter(Boolean),
  adminEmails: (env.ADMIN_EMAILS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
};

export type CredentialGroup = "models" | "collectors" | "integrations" | "auth";

const groupCache = new Map<CredentialGroup, Record<string, string>>();

/**
 * Loads one credential group from an optional dotenv file (AIHOT_CREDENTIALS_DIR/<group>.env). Values
 * in the environment always win; a normal deployment only uses environment variables (.env).
 */
export function credentials(group: CredentialGroup): Record<string, string> {
  const cached = groupCache.get(group);
  if (cached) return cached;
  const file = config.credentialsDir ? path.join(config.credentialsDir, `${group}.env`) : null;
  const parsed: Record<string, string> = file && existsSync(file) ? (parseEnv(readFileSync(file, "utf8")) as Record<string, string>) : {};
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) merged[key] = env[key] ?? value;
  groupCache.set(group, merged);
  return merged;
}

export function credential(group: CredentialGroup, name: string): string | null {
  const value = env[name] ?? credentials(group)[name];
  return value && value.trim() !== "" ? value : null;
}

const PLACEHOLDER = /^(changeme|placeholder|dummy|test|xxx+|your[-_ ].*|<.*>)$/i;

/** Production refuses to start with missing or placeholder critical secrets, or dev-login bypasses. */
export function assertProductionSecrets(names: Array<[CredentialGroup, string]>): void {
  if (!isProduction) return;
  const problems: string[] = [];
  for (const [group, name] of names) {
    const value = credential(group, name);
    if (!value || PLACEHOLDER.test(value) || value.length < 8) problems.push(name);
  }
  for (const key of Object.keys(env)) if (key.startsWith("DEV_AUTH_")) problems.push(`${key} (dev login bypass)`);
  if (config.allowPrivateNetworkFetch) problems.push("ALLOW_PRIVATE_NETWORK_FETCH");
  if (problems.length > 0) throw new Error(`Refusing to start in production: ${problems.join(", ")}`);
}
