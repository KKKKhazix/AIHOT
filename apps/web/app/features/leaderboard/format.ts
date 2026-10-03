import type { LbPrice } from "@aihot/contracts/leaderboard";
import { beijingDate, beijingTime } from "@aihot/contracts/time";

/** ≥ ¥0.1 → up to two decimals; smaller amounts keep three significant digits. */
export function yuan(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "免费";
  const n = v >= 0.1 ? Number(v.toFixed(2)) : Number(v.toPrecision(3));
  return `¥${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}

/** A checked model the vendor sells no paid API for (retired, weights only, free trial only). */
export function noOfficialApi(p: LbPrice | null): boolean {
  return !!p && p.input == null && p.output == null;
}

export function listPrice(v: number | null, currency: LbPrice["currency"]): string {
  if (v == null) return "—";
  return currency === "USD" ? `$${Number(v.toPrecision(6))}` : yuan(v);
}

/** "09/26 20:00" in Beijing time, as the leaderboard has always shown update times. */
export function shortStamp(iso: string | null | undefined): string {
  if (!iso) return "待核实";
  return `${beijingDate(iso).slice(5).replace("-", "/")} ${beijingTime(iso)}`;
}

export function pct(weight: number, digits = 1): string {
  const v = weight * 100;
  return `${Number(v.toFixed(digits))}%`;
}

/** Always one decimal, as the shared-evidence tables print weights ("5.0%"). */
export function pctFixed(weight: number): string {
  return `${(weight * 100).toFixed(1)}%`;
}

export function tokensWan(n: number | null): string {
  if (!n) return "—";
  const w = n / 10000;
  return `${Number(w >= 100 ? w.toFixed(1) : w.toFixed(1))}万`.replace(".0万", "万");
}

export function boardHref(key: string): string {
  return key === "overall" ? "/leaderboard" : `/leaderboard/category/${key}`;
}

export function modelHref(slug: string, from?: string | null): string {
  return from && from !== "overall" ? `/leaderboard/${slug}?from=${from}` : `/leaderboard/${slug}`;
}

/** One decimal for the comparative index; a missing score is never shown as zero. */
export function score(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(1);
}
