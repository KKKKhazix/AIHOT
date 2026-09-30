import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { IntentLink } from "./IntentLink";
import { useEntrance } from "../../lib/hydration";

/** Where each switch's thumb sat when it last left, relative to its track. */
const thumbs = new Map<string, { left: number; width: number; at: number }>();

function placeOf(el: HTMLElement) {
  const tab = el.parentElement!.getBoundingClientRect();
  const track = el.closest("[data-pill-track]")?.getBoundingClientRect();
  return { left: tab.left - (track?.left ?? 0), width: tab.width, at: Date.now() };
}

/**
 * The white thumb inside the chosen option. It is rendered in place (so it is right without
 * JavaScript) and, when the choice moves, glides over from where the previous thumb was.
 */
function Thumb({ id }: { id: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const entrance = useEntrance();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = placeOf(el);
    const prev = thumbs.get(id);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (entrance && !reduce && prev && now.at - prev.at < 1000 && (prev.left !== now.left || prev.width !== now.width) && el.animate) {
      el.animate(
        [{ transform: `translateX(${prev.left - now.left}px)`, width: `${prev.width}px` }, { transform: "translateX(0)", width: `${now.width}px` }],
        { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
      );
    }
    return () => {
      thumbs.set(id, placeOf(el));
    };
  }, [id, entrance]);
  return <span ref={ref} className={THUMB} />;
}

export interface TabItem {
  key: string;
  label: ReactNode;
  /** Link target; tabs without one call onSelect. */
  to?: string;
  prefetch?: "intent";
  replace?: boolean;
  count?: number | null;
}

const SIZES = {
  md: "h-9 px-4 text-[14px]",
  sm: "h-8 px-3.5 text-[13px]",
  xs: "h-7 px-3 text-[12.5px]",
} as const;

const TRACK = "gap-0.5 rounded-full bg-bg-sunk p-[3px] ring-1 ring-inset ring-line-soft dark:bg-bg-muted/60";
const THUMB = "absolute inset-0 rounded-full bg-surface shadow-[var(--shadow-thumb)] ring-1 ring-line dark:bg-raised";

function optionClass(size: keyof typeof SIZES, on: boolean) {
  return `relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full font-medium outline-offset-1 transition-colors duration-150 active:scale-[0.98] ${SIZES[size]} ${on ? "text-ink" : "text-ink-3 hover:text-ink"}`;
}

/**
 * The site's one switch control: a grey pill track with a white thumb that glides to the chosen
 * option. Boards, categories, sources, report kinds, page sections and language all use it, so every
 * switch looks and moves the same. Scrolls sideways when it runs out of room; `fill` spreads the
 * options evenly across the available width.
 */
export function PillTabs({
  items, active, onSelect, layoutId, size = "md", label, fill = false, className = "",
}: {
  items: TabItem[];
  active: string;
  onSelect?: (key: string) => void;
  /** Unique per control on a page, for the gliding thumb. */
  layoutId: string;
  size?: keyof typeof SIZES;
  label?: string;
  fill?: boolean;
  className?: string;
}) {
  const links = items.some((t) => t.to);
  const Track = links ? "nav" : "div";
  return (
    <div className={`scrollbar-none max-w-full overflow-x-auto ${fill ? "w-full" : ""} ${className}`}>
      <Track
        data-pill-track=""
        aria-label={label}
        role={links ? undefined : "tablist"}
        className={`${fill ? "grid w-full" : "inline-flex w-max"} ${TRACK}`}
        style={fill ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` } : undefined}
      >
        {items.map((t) => {
          const on = t.key === active;
          const inner = (
            <>
              {on && <Thumb id={layoutId} />}
              <span className="relative inline-flex items-center gap-1">
                {t.label}
                {t.count !== undefined && t.count !== null && <span className={`num text-[0.86em] font-normal ${on ? "text-ink-3" : "text-ink-4"}`}>{t.count}</span>}
              </span>
            </>
          );
          const cls = optionClass(size, on);
          const TabLink = t.prefetch === "intent" ? IntentLink : Link;
          return t.to ? (
            <TabLink key={t.key} to={t.to} replace={t.replace} preventScrollReset aria-current={on ? "page" : undefined} className={cls}>
              {inner}
            </TabLink>
          ) : (
            <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => onSelect?.(t.key)} className={cls}>
              {inner}
            </button>
          );
        })}
      </Track>
    </div>
  );
}

/**
 * Filters that combine, in the same pill track: each option turns on and off by itself, and the
 * leading "all" option is chosen while none is on and clears them.
 */
export function PillToggles({
  items, selected, onChange, allLabel = "全部", label, size = "sm", className = "",
}: {
  items: Array<{ key: string; label: ReactNode }>;
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel?: ReactNode;
  label: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const options = [{ key: "", label: allLabel }, ...items];
  return (
    <div className={`scrollbar-none max-w-full overflow-x-auto ${className}`}>
      <div role="group" aria-label={label} className={`inline-flex w-max ${TRACK}`}>
        {options.map((t) => {
          const on = t.key ? selected.includes(t.key) : selected.length === 0;
          const next = !t.key ? [] : on ? selected.filter((k) => k !== t.key) : [...selected, t.key];
          return (
            <button key={t.key || "all"} type="button" aria-pressed={on} onClick={() => onChange(next)} className={optionClass(size, on)}>
              {on && <span className={THUMB} />}
              <span className="relative">{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
