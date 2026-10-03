// Beijing-time wording for the reset monitor. Inputs are ISO strings with +08:00.
import { addDays } from "@aihot/contracts/time";
import { monthDay } from "../../lib/format";

export function bjDate(iso: string): string {
  return iso.slice(0, 10);
}

export function bjTime(iso: string): string {
  return iso.slice(11, 16);
}

/** 今天 / 明天 / 昨天 / 9月12日 */
export function dayWord(date: string, today: string): string {
  if (date === today) return "今天";
  if (date === addDays(today, 1)) return "明天";
  if (date === addDays(today, -1)) return "昨天";
  return monthDay(date);
}

export function windowText(from: string | null, through: string | null, today: string): string {
  if (!from) return "";
  const a = `${dayWord(bjDate(from), today)} ${bjTime(from)}`;
  if (!through || through === from) return a;
  const sameDay = bjDate(from) === bjDate(through);
  return sameDay ? `${a}–${bjTime(through)}` : `${a}–${dayWord(bjDate(through), today)} ${bjTime(through)}`;
}

export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** "9/26 21:40" */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} ${bjTime(iso)}`;
}

export function typeName(type: "direct_reset" | "reset_credit"): string {
  return type === "reset_credit" ? "重置卡发放" : "Codex 额度重置";
}
