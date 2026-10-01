// Process heartbeats for the runs view and the watchdog: one settings row per process role.
import { hostname } from "node:os";
import { sql } from "../db.ts";

const startedAt = new Date().toISOString();

export type Heartbeat = {
  pid: number;
  host: string;
  release: string;
  startedAt: string;
  at: string;
};

export async function beat(role: string, detail: Record<string, unknown> = {}) {
  const value: Heartbeat = { ...detail, pid: process.pid, host: hostname(), release: process.env.AIHOT_RELEASE ?? "dev", startedAt, at: new Date().toISOString() };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`heartbeat.${role}`}, ${sql.json(value)}, ${role})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** Beats now and every minute until the process exits. */
export function startHeartbeat(role: string): NodeJS.Timeout {
  void beat(role).catch(() => {});
  const timer = setInterval(() => void beat(role).catch(() => {}), 60_000);
  timer.unref();
  return timer;
}
