import type { HotEntryView } from "@aihot/contracts/site";
import { useT } from "../../lib/i18n";

/** Change against six hours before the ranking: up in the hot tone, down quiet, new stories marked new, none while sources are behind. */
export function Delta({ trend, pct, className = "" }: { trend: HotEntryView["trend"]; pct: number | null; className?: string }) {
  const t = useT();
  const base = `inline-flex h-[22px] shrink-0 items-center gap-0.5 rounded-full px-2 text-ui-caption-md font-medium tabular-nums ${className}`;
  if (trend === "unknown") return <span className={`${base} bg-well text-ink-4`} title={t("部分来源更新稍慢，暂不与 6 小时前对比", "Some sources are delayed, so the 6-hour change isn't shown right now")}>{t("暂不比较", "Not comparable")}</span>;
  if (trend === "new" || pct === null) return <span className={`${base} bg-accent-soft text-accent`}>{t("新上榜", "New")}</span>;
  if (trend === "flat") return <span className={`${base} bg-well text-ink-4`} title={t("较 6 小时前", "Compared with 6 hours ago")}>{t("持平", "Steady")}</span>;
  const up = trend === "up";
  return (
    <span className={`${base} ${up ? "bg-hot-soft text-hot" : "bg-well text-ink-4"}`} title={t("较 6 小时前", "Compared with 6 hours ago")}>
      {up ? "↑" : "↓"} {Math.abs(Math.round(pct))}%
    </span>
  );
}
