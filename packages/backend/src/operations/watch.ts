// The worker watchdog, run from the api process (the worker cannot report its own death). It keeps its
// state in settings and sends its own alerts.
import { sql } from "../db.ts";
import { beijingStamp, formatAlert, formatRecovery, sendAlert, type Finding } from "../notify/feishu.ts";

// The process manager restarts a crashed worker within seconds and a deploy restarts it on purpose;
// half an hour without a heartbeat means those did not help.
const WORKER_STALE_MS = 30 * 60_000;

const WORKER_DOWN: Finding = {
  key: "worker",
  level: "now",
  title: "后台处理服务停了，网站不会出现新内容",
  impact: "新内容的采集、处理、推送和日报全部暂停，网站停在旧内容上",
  heals: "系统自动重启没有成功",
  action: "转给 AI 立即处理",
};

/**
 * Runs in the api process: alerts once when the worker's heartbeat is older than half an hour, and once
 * when it recovers. The stored state moves only after the message went out, so a failed send is tried
 * again at the next check; the lock keeps two api processes from both sending.
 */
export async function checkWorkerHeartbeat(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('watchdog.worker'))`;
    const [hb] = await tx<{ updated_at: Date }[]>`SELECT updated_at FROM settings WHERE key = 'heartbeat.worker'`;
    if (!hb) return;
    const [prior] = await tx<{ value: { state: "up" | "down"; since: string } }[]>`SELECT value FROM settings WHERE key = 'watchdog.worker'`;
    const stale = Date.now() - hb.updated_at.getTime() > WORKER_STALE_MS;
    const state = stale ? "down" : "up";
    if (prior?.value.state === state) return;
    // A first check that finds the worker running only records it.
    const msg = stale
      ? formatAlert({ ...WORKER_DOWN, detail: `worker 心跳停在 ${beijingStamp(hb.updated_at)}；看 worker 的日志（docker compose logs worker）` }, hb.updated_at, Date.now())
      : prior && formatRecovery(WORKER_DOWN.title, new Date(prior.value.since), Date.now());
    if (msg) await sendAlert(msg.title, msg.lines);
    // "since" of a down state is the last heartbeat, so the recovery can say how long it lasted.
    const since = stale ? hb.updated_at : new Date();
    await tx`INSERT INTO settings (key, value, updated_by) VALUES ('watchdog.worker', ${tx.json({ state, since: since.toISOString() })}, 'api')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  });
}

export function startWorkerWatchdog(): NodeJS.Timeout {
  const timer = setInterval(() => void checkWorkerHeartbeat().catch(() => {}), 5 * 60_000);
  timer.unref();
  return timer;
}
