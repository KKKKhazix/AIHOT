// The worker watchdog, run from the api process: the worker cannot report its own death.
import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { beijingStamp, formatAlert, formatRecovery, sendAlert, type Finding } from "../notify/feishu.ts";

interface PendingNotice {
  id: string;
  state: "up" | "down";
  since: string;
  at: string;
}

interface WatchState {
  state: "up" | "down";
  since: string;
  pending?: PendingNotice[];
  lease?: { token: string; until: string };
}

const DELIVERY_LEASE_MS = 2 * 60_000;

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
 * API 记录心跳状态和待发通知；短事务认领队首，发送期间不持有数据库锁。
 * 外部成功但回执丢失时可能重复投递，重试保留同一通知编号，不承诺恰好一次。
 */
export async function checkWorkerHeartbeat(): Promise<void> {
  const claimed = await sql.begin(async (tx) => {
    // 首次还没有 settings 行时也需串行；行锁另与发送后的条件确认更新互斥。
    await tx`SELECT pg_advisory_xact_lock(hashtext('watchdog.worker'))`;
    const [row] = await tx<{ value: WatchState }[]>`SELECT value FROM settings WHERE key = 'watchdog.worker' FOR UPDATE`;
    const [hb] = await tx<{ updated_at: Date; now: Date }[]>`
      SELECT updated_at, clock_timestamp() AS now FROM settings WHERE key = 'heartbeat.worker'`;
    if (!hb) return null;
    const now = hb.now.getTime();
    const stale = now - hb.updated_at.getTime() > WORKER_STALE_MS;
    const next = stale ? "down" : "up";
    const prior = row?.value;
    const changed = !prior || prior.state !== next;
    const since = stale ? hb.updated_at.toISOString() : hb.now.toISOString();
    let value: WatchState = prior ?? { state: next, since, pending: [] };
    if (changed) {
      const pending = [...(prior?.pending ?? [])];
      // 首次健康只初始化；旧格式的同态记录不追溯重发，但以后的变化都持久入队。
      if (stale || prior) pending.push({
        id: randomUUID(), state: next, at: hb.now.toISOString(),
        since: stale ? since : prior?.state === "down" ? prior.since : hb.updated_at.toISOString(),
      });
      value = { ...prior, state: next, since, pending };
    }
    const notice = value.pending?.[0];
    const token = notice && (!value.lease || Date.parse(value.lease.until) <= now) ? randomUUID() : null;
    if (token) value.lease = { token, until: new Date(now + DELIVERY_LEASE_MS).toISOString() };
    if (changed || token) await tx`
      INSERT INTO settings (key, value, updated_by) VALUES ('watchdog.worker', ${tx.json(value as never)}, 'api')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    return token && notice ? { notice, token } : null;
  });
  if (!claimed) return;
  const { notice, token } = claimed;
  const since = new Date(notice.since);
  const at = Date.parse(notice.at);
  const msg = notice.state === "down"
    ? formatAlert({ ...WORKER_DOWN, detail: `worker 心跳停在 ${beijingStamp(since)}；看 worker 的日志（docker compose logs worker）` }, since, at)
    : formatRecovery(WORKER_DOWN.title, since, at);
  msg.lines.push(`通知编号：${notice.id}（${beijingStamp(at)} 记录）`);
  let sent = false;
  try {
    sent = await sendAlert(msg.title, msg.lines) === "sent";
  } finally {
    // 失败或关闭只释放租约；旧尝试的迟到结果不能清掉重领的租约或后续恢复通知。
    await sql`UPDATE settings
      SET value = ${sent ? sql`jsonb_set(value, '{pending}', (value->'pending') - 0) - 'lease'` : sql`value - 'lease'`}, updated_at = now()
      WHERE key = 'watchdog.worker' AND value #>> '{pending,0,id}' = ${notice.id} AND value #>> '{lease,token}' = ${token}`;
  }
}

export function startWorkerWatchdog(): NodeJS.Timeout {
  const timer = setInterval(() => void checkWorkerHeartbeat().catch(() => {}), 5 * 60_000);
  timer.unref();
  return timer;
}
