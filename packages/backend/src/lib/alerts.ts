// Operations alert domain types and plain-language formatters shared by engine checks, modules and delivery.
import { beijingStamp } from "@aihot/contracts/time";

/** How urgent: readers affected now, money or the owner's hands today, or a follow-up that can wait. */
export type Level = "now" | "today" | "later";

interface FindingFields {
  key: string;
  level: Level;
  /** Plain words: no queue, unit or table names. */
  title: string;
  /** What readers see, or what it costs. */
  impact?: string;
  /** Whether it heals by itself. */
  heals?: string;
  /** What has to be done. */
  action?: string;
  /** Facts for whoever looks into it: the 09:00 digest lists them, an alert to the owner never carries them. */
  detail?: string;
  /** When the problem began, when known; otherwise when it was first seen. */
  since?: Date;
  /** New evidence after a dated closure reopens a source follow-up under the same key. */
  observedAt?: Date;
  /**
   * The owner hears of it at once even while an agent takes the alerts (operations/alerts.ts): only the owner
   * can act (paying, renewing, a device beside them), or what would act has stopped (the whole site, the
   * machine the agent runs on, the channel to the agent). "only": nothing in it is the agent's to do (a
   * top-up), so the agent is not woken for it. "private" also limits delivery to the owner's private chat.
   */
  owner?: true | "only" | "private";
  /**
   * The agent is the one to act: whenever the owner is messaged about it, the agent is woken first and the
   * message says so instead of asking him to pass it on (operations/alerts.ts).
   */
  agentFirst?: true;
  /**
   * Do not message the owner, including when it clears or when a follow-up is derived from the handoff.
   * On the incident itself it is now or today and is woken: a later finding is not. One such key is one
   * occurrence, so the wake's event id is the key, not a time. The derived follow-up keeps the flag and
   * stays on the ops list only.
   */
  agentOnly?: true;
  /**
   * How long it must stay gone before its recovery is told; back within that time it is the same incident and
   * nothing is sent (operations/alerts.ts). For problems that come and go, such as a provider's outage.
   */
  settles?: number;
}

/**
 * An agent-only finding names what kind of work it is (`alert.<kind>`); which rule of the hub takes that kind, and when,
 * is the hub's to say. No default: a new kind must not fall silently to another kind's handling.
 */
export type Finding = FindingFields & ({ agentOnly?: undefined; agentType?: undefined } | { agentOnly: true; agentType: `alert.${string}` });

export type FollowUp = Finding & { level: "later" };

const MARK: Record<Exclude<Level, "later">, string> = { now: "🔴", today: "🟠" };

export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分钟` : ""}`;
  return `${Math.floor(min / 1440)} 天`;
}

/** The message for an open problem: first notice or a repeat. */
export function formatAlert(f: Finding, since: Date, now: number, repeat = false): { title: string; lines: string[] } {
  const level = f.level === "later" ? "today" : f.level;
  const lasting = now - since.getTime() >= 60_000 ? `（已持续 ${duration(now - since.getTime())}）` : "";
  const lines = [f.impact && `影响：${f.impact}`, f.heals && `会自己好吗：${f.heals}`, f.action && `你需要：${f.action}`];
  return { title: `${MARK[level]} ${repeat ? "仍未恢复：" : ""}${f.title}${lasting}`, lines: lines.filter((l): l is string => !!l) };
}

/** A problem handed to the agent that keeps coming back: told once, with no recovery to follow. */
export function formatReturn(f: Finding, count: number): { title: string; lines: string[] } {
  const level = f.level === "later" ? "today" : f.level;
  const lines = [f.impact && `影响：${f.impact}`, "会自己好吗：每次都交给 AI 处理好了，但又出现，说明还没修到根上", "你需要：让 AI 查清它为什么反复出现，不只处理这一次"];
  return { title: `${MARK[level]} 反复出现：${f.title}（一天内第 ${count} 次）`, lines: lines.filter((l): l is string => !!l) };
}

export function formatRecovery(title: string, since: Date, now: number): { title: string; lines: string[] } {
  return { title: `✅ 已恢复：${title}`, lines: [`持续 ${duration(now - since.getTime())}（${beijingStamp(since)} 起）`] };
}
