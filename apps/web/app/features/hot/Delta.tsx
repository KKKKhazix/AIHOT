import type { HotEntryView } from "@aihot/contracts/site";

/** Change against six hours before the ranking: up in the hot tone, down quiet, new stories marked new, none while sources are behind. */
export function Delta({ trend, pct, className = "" }: { trend: HotEntryView["trend"]; pct: number | null; className?: string }) {
  const base = `inline-flex h-[22px] shrink-0 items-center gap-0.5 rounded-full px-2 text-ui-caption-md font-medium tabular-nums ${className}`;
  if (trend === "unknown") return <span className={`${base} bg-well text-ink-4`} title="部分来源更新稍慢，暂不与 6 小时前对比">暂不比较</span>;
  if (trend === "new" || pct === null) return <span className={`${base} bg-accent-soft text-accent`}>新上榜</span>;
  if (trend === "flat") return <span className={`${base} bg-well text-ink-4`} title="较 6 小时前">持平</span>;
  const up = trend === "up";
  return (
    <span className={`${base} ${up ? "bg-hot-soft text-hot" : "bg-well text-ink-4"}`} title="较 6 小时前">
      {up ? "↑" : "↓"} {Math.abs(Math.round(pct))}%
    </span>
  );
}
