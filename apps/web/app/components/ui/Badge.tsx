import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

type Tone = "selected" | "accent" | "amber" | "hot" | "ok" | "neutral";

const TONES: Record<Tone, string> = {
  selected: "bg-amber-soft text-amber-ink",
  accent: "bg-accent-soft text-accent",
  amber: "bg-amber-soft text-amber-ink",
  hot: "bg-hot-soft text-hot",
  ok: "bg-ok-soft text-ok",
  neutral: "bg-bg-sunk text-ink-3 border border-line-soft",
};

/** Small label next to a source or title: 精选, statuses and counts. */
export function Badge({ tone = "neutral", dot = false, children, className = "", title }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-2 text-ui-caption-sm font-medium leading-none ${TONES[tone]} ${className}`}>
      {dot && <span className="size-[5px] rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** The "精选" mark on a report. */
export function SelectedBadge() {
  const t = useT();
  return (
    <Badge tone="selected" dot>
      {t("精选", "Top Pick")}
    </Badge>
  );
}

/** A selected report whose fact is shown by another report (the one holding its selected seat). */
export function SameEventBadge() {
  const t = useT();
  return <Badge title={t("这件事已有另一篇入选精选", "Another report on this story is already in Top Picks")}>{t("同事件", "Same story")}</Badge>;
}
