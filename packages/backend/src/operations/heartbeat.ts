// Process heartbeats for the runs view and the watchdog: one settings row per process role.
import { hostname } from "node:os";
import { sql, type Db } from "../db.ts";
import { logError } from "../lib/log-error.ts";

const startedAt = new Date().toISOString();

/** What a process writes to `settings.heartbeat.<role>` (the runs view and the watchdog read it). */
export type Heartbeat = {
  pid: number;
  host: string;
  release: string;
  startedAt: string;
  at: string;
};

async function beat(role: string) {
  const value: Heartbeat = { pid: process.pid, host: hostname(), release: process.env.AIHOT_RELEASE ?? "dev", startedAt, at: new Date().toISOString() };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`heartbeat.${role}`}, ${sql.json(value)}, ${role})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** Beats now and every minute until the process exits. */
export function startHeartbeat(role: string): NodeJS.Timeout {
  const warn = (error: unknown) => console.warn(JSON.stringify({ level: "warn", msg: "heartbeat write failed", role, err: logError(error) }));
  void beat(role).catch(warn);
  const timer = setInterval(() => void beat(role).catch(warn), 60_000);
  timer.unref();
  return timer;
}

/** Reads one process role's latest heartbeat record. */
export async function readHeartbeat(role: string, db: Db = sql): Promise<{ value: Heartbeat; updated_at: Date } | null> {
  const [row] = await db<{ value: Heartbeat; updated_at: Date }[]>`SELECT value, updated_at FROM settings WHERE key = ${`heartbeat.${role}`}`;
  return row ?? null;
}

/** Lists all recorded process heartbeats ordered by role name. */
export async function listHeartbeats(): Promise<Array<{ role: string; value: Heartbeat; updated_at: Date }>> {
  const rows = await sql<{ key: string; value: Heartbeat; updated_at: Date }[]>`SELECT key, value, updated_at FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY key`;
  return rows.map((h) => ({ role: h.key.slice("heartbeat.".length), value: h.value, updated_at: h.updated_at }));
}
