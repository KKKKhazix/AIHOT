// Admin display helpers: Beijing wall-clock times, relative ages, compact numbers.
import { beijingDate, beijingTime } from "@aihot/contracts/time";

const numberFormats = new Map<number, Intl.NumberFormat>();
const moneyFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const smallMoneyFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3, minimumFractionDigits: 2 });

export function bj(iso: string | Date | null | undefined, withYear = false): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return "—";
  const date = beijingDate(iso);
  return `${withYear ? date : date.slice(5)} ${beijingTime(iso)}`;
}

export function ago(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return "从未";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const future = ms < 0;
  const a = Math.abs(ms);
  const text =
    a < 60_000 ? `${Math.max(1, Math.round(a / 1000))} 秒`
    : a < 3600_000 ? `${Math.round(a / 60_000)} 分钟`
    : a < 86400_000 ? `${Math.round(a / 3600_000)} 小时`
    : `${Math.round(a / 86400_000)} 天`;
  return future ? `${text}后` : `${text}前`;
}

export function num(n: number | string | null | undefined, digits = 0): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  let format = numberFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
    numberFormats.set(digits, format);
  }
  return format.format(v);
}

export function money(n: number | string | null | undefined, currency = "CNY"): string {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  const sign = currency === "USD" ? "$" : "¥";
  return `${sign}${(v < 10 ? smallMoneyFormat : moneyFormat).format(v)}`;
}

export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function pct(v: number | null | undefined, digits = 1): string {
  return v === undefined || v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}
