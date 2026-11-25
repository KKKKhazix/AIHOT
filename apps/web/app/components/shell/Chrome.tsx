import { useEffect, useRef, useState } from "react";
import { IconArrowUp } from "../icons";
import { scrollBehavior } from "../../lib/motion";
import { useT } from "../../lib/i18n";

/**
 * Set by the tab bar as the reader taps the tab they are on at the top: the refresh that follows shows the line at
 * once. A page refreshing itself (the reset tracker's new version) or pull-to-refresh (its own ring) does not.
 */
export const refreshAsked = { current: false };

/** A thin accent line while a navigation is in flight (shown only if it takes a moment). */
export function NavigationProgress({ active, immediate = false }: { active: boolean; immediate?: boolean }) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A refresh the reader asked for (the tab tapped again at the top) shows at once, however quick: the bar
    // filling and fading is the only sign the tap was taken. Page changes wait a moment, so quick ones don't flash.
    if (active && immediate) setVisible(true);
    else if (active) timer.current = setTimeout(() => setVisible(true), 150);
    else {
      if (timer.current) clearTimeout(timer.current);
      setVisible(false);
      refreshAsked.current = false;
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, immediate]);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] overflow-hidden" aria-hidden="true">
      <div
        className="h-full origin-left bg-accent"
        style={{
          transform: `scaleX(${visible ? 0.85 : active ? 0 : 1})`,
          opacity: visible ? 1 : 0,
          transition: visible ? "transform 2.4s cubic-bezier(0.1, 0.7, 0.2, 1), opacity 120ms" : "transform 200ms, opacity 300ms 120ms",
        }}
      />
    </div>
  );
}

/** Round "back to top" button once the reader has scrolled a screen or so (desktop; on phones the tab bar does it). */
export function BackToTop() {
  const t = useT();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > window.innerHeight * 1.2);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <button
      type="button"
      aria-label={t("回到顶部", "Back to top")}
      onClick={() => window.scrollTo({ top: 0, behavior: scrollBehavior() })}
      className={`fixed bottom-[max(24px,env(safe-area-inset-bottom))] right-[max(24px,env(safe-area-inset-right))] z-30 hidden size-11 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-[var(--shadow-soft)] transition-all duration-200 hover:text-ink lg:flex ${
        shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <IconArrowUp size={18} />
    </button>
  );
}
