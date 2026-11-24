import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

/** A small spaced label in the accent, led by a short bar: 头条, 今日看点, 关于本站. English spells it in capitals, barely spaced. */
export function Kicker({ children, className = "" }: { children: ReactNode; className?: string }) {
  const t = useT();
  return (
    <div className={`flex items-center gap-2.5 text-ui-caption font-semibold ${t("tracking-[0.3em]", "uppercase tracking-[0.08em]")} text-accent ${className}`}>
      <span className="h-[2px] w-6 rounded-full bg-accent" aria-hidden="true" />
      {children}
    </div>
  );
}
