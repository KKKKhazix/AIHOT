import type { ReactNode } from "react";

/** A small spaced label in the accent, led by a short bar: 头条, 今日看点, 关于本站. */
export function Kicker({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 text-ui-caption font-semibold tracking-[0.3em] text-accent ${className}`}>
      <span className="h-[2px] w-6 rounded-full bg-accent" aria-hidden="true" />
      {children}
    </div>
  );
}
