import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { IntentLink } from "./IntentLink";
import { useEntrance } from "../../lib/hydration";
import { MOTION, reducedMotion, scrollBehavior } from "../../lib/motion";
import { Link } from "../../lib/link";
import { useLocation } from "react-router";
import { localizePath, useLocale } from "../../lib/i18n";

/** Where each switch's thumb was on screen when it last left, relative to its track. */
const thumbs = new Map<string, { left: number; width: number; at: number }>();

/** The thumb as it is drawn, mid-glide included, so a choice changed again turns it from where it is. */
function placeOf(el: HTMLElement) {
  const thumb = el.getBoundingClientRect();
  const track = el.closest("[data-pill-track]")?.getBoundingClientRect();
  return { left: thumb.left - (track?.left ?? 0), width: thumb.width, at: Date.now() };
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
    if (entrance && !reducedMotion() && prev && now.at - prev.at < 1000 && (Math.abs(prev.left - now.left) > 0.5 || Math.abs(prev.width - now.width) > 0.5) && el.animate) {
      el.animate(
        [{ transform: `translateX(${prev.left - now.left}px)`, width: `${prev.width}px` }, { transform: "translateX(0)", width: `${now.width}px` }],
        { duration: MOTION.move, easing: MOTION.easeOut },
      );
    }
    return () => {
      thumbs.set(id, placeOf(el));
    };
  }, [id, entrance]);
  return <span ref={ref} className="absolute inset-0 rounded-full bg-surface shadow-[var(--shadow-thumb)] ring-1 ring-line dark:bg-raised" />;
}

export interface TabItem {
  key: string;
  label: ReactNode;
  /** Link target; tabs without one call onSelect. */
  to?: string;
  /** Link relationship (e.g. "nofollow" for filtered views crawlers are kept from). */
  rel?: string;
  /** Prefetch the page when the reader presses the tab (IntentLink). */
  prefetchOnPress?: boolean;
  replace?: boolean;
  /** Start the page it opens at the top (another page rather than another view of this one). */
  resetScroll?: boolean;
  count?: number | null;
}

const SIZES = {
  md: "h-11 px-4 text-ui-body-sm lg:h-9 touch:h-11",
  sm: "h-11 px-3.5 text-ui-label lg:h-8 touch:h-11",
  xs: "h-11 px-3 text-ui-caption-lg lg:h-7 touch:h-11",
} as const;

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
  // A row that scrolls sideways brings the chosen option into view: at once when the page opens on it,
  // gliding when the reader chooses one half hidden at the edge.
  const row = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const box = row.current;
    const tab = box?.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
    const opened = first.current;
    first.current = false;
    if (!box || !tab || box.scrollWidth <= box.clientWidth) return;
    const edge = 16;
    const at = tab.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    const left = at - edge;
    const right = at + tab.offsetWidth + edge - box.clientWidth;
    const to = box.scrollLeft > left ? left : box.scrollLeft < right ? right : null;
    if (to !== null) box.scrollTo({ left: to, behavior: opened ? "auto" : scrollBehavior() });
  }, [active]);
  // The option already shown, pressed again, leaves the page as it is: following the same address would load the
  // list again from its top and lose what was scrolled to.
  const { pathname, search } = useLocation();
  const locale = useLocale();
  const here = `${pathname}${search}`;
  return (
    <div ref={row} className={`scrollbar-none max-w-full overflow-x-auto ${fill ? "w-full" : ""} ${className}`}>
      <Track
        data-pill-track=""
        aria-label={label}
        role={links ? undefined : "tablist"}
        className={`${fill ? "grid w-full" : "inline-flex w-max"} gap-0.5 rounded-full bg-well p-0.5 lg:p-[3px] ring-1 ring-inset ring-line-soft`}
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
          const cls = `relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full font-medium outline-offset-1 press ${SIZES[size]} ${on ? "text-ink" : "text-ink-3 hover:text-ink"}`;
          const TabLink = t.prefetchOnPress ? IntentLink : Link;
          return t.to ? (
            <TabLink key={t.key} to={t.to} rel={t.rel} replace={t.replace} preventScrollReset={!t.resetScroll} aria-current={on ? "page" : undefined} onClick={on && localizePath(t.to, locale) === here ? (e) => e.preventDefault() : undefined} className={cls}>
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
