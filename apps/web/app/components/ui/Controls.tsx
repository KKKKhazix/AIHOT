import type { ReactNode, SelectHTMLAttributes } from "react";
import { IconCheck, IconChevronDown } from "../icons";

type Variant = "primary" | "secondary";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:bg-accent-ink disabled:opacity-45",
  secondary: "border border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink disabled:opacity-50",
};

type Size = "sm" | "md" | "lg";
const SIZES: Record<Size, string> = {
  sm: "h-11 px-3.5 text-ui-caption-lg lg:h-8 touch:h-11",
  md: "h-11 px-4 text-ui-label-lg lg:h-9 touch:h-11",
  lg: "h-11 px-5 text-ui-body-sm-plus",
};

/** The pill button's classes, for links that look like buttons. */
export function buttonClass(variant: Variant = "secondary", size: Size = "md"): string {
  return `inline-flex items-center justify-center gap-1.5 rounded-full font-medium press ${SIZES[size]} ${VARIANTS[variant]}`;
}

/** Native select as a pill, like the site's other controls. */
export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <select
        className="h-11 w-full cursor-pointer appearance-none rounded-full border border-line-strong bg-surface py-0 pl-3.5 pr-8 text-ui-body-lg text-ink-2 outline-none lg:h-8 lg:text-ui-caption-lg touch:h-11 transition-colors hover:border-ink-4 focus:border-accent"
        {...rest}
      >
        {children}
      </select>
      <IconChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-4" />
    </span>
  );
}

/**
 * A filter that combines with others: a pill with its own small check mark, so a row of them reads
 * as "pick any" rather than the one-of-many `PillTabs` switch.
 */
export function ToggleChip({ on, onToggle, children }: { on: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={`inline-flex h-11 shrink-0 lg:h-8 touch:h-11 select-none items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-3.5 text-ui-label font-medium press ${on ? "border-accent/35 bg-accent-soft text-accent" : "border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink"}`}
    >
      <span aria-hidden="true" className={`inline-flex size-4 items-center justify-center rounded-full border transition-colors ${on ? "border-accent bg-accent text-accent-contrast" : "border-line-strong"}`}>
        {on && <IconCheck size={11} strokeWidth={3} className="anim-swap-in" />}
      </span>
      {children}
    </button>
  );
}
