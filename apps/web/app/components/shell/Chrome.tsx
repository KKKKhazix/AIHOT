import { useEffect, useState } from "react";
import { IconArrowUp } from "../icons";
import { MOTION, scrollBehavior } from "../../lib/motion";
import { useT } from "../../lib/i18n";

/**
 * Set by the tab bar as the reader taps the tab they are on at the top: the refresh that follows shows the line at
 * once. A page refreshing itself (the reset tracker's new version) or pull-to-refresh (its own ring) does not.
 */
export const refreshAsked = { current: false };

/** A thin accent line while a navigation is in flight (shown only if it takes a moment). */
export function NavigationProgress({ active, immediate = false }: { active: boolean; immediate?: boolean }) {
  // idle: nothing; running: creeping towards the end while the page loads; done: it fills and fades. A new
  // navigation while the last one fades starts again from nothing, rather than shrinking back across.
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  useEffect(() => {
    if (active) {
      // A refresh the reader asked for (the tab tapped again at the top) shows at once, however quick: the bar
      // filling and fading is the only sign the tap was taken. Page changes wait a moment, so quick ones don't flash.
      if (immediate) {
        setPhase("running");
        return;
      }
      setPhase("idle");
      const timer = setTimeout(() => setPhase("running"), 150);
      return () => clearTimeout(timer);
    }
    setPhase((p) => (p === "running" ? "done" : "idle"));
    refreshAsked.current = false;
  }, [active, immediate]);
  useEffect(() => {
    if (phase !== "done") return;
    const timer = setTimeout(() => setPhase("idle"), MOTION.move + MOTION.feedback);
    return () => clearTimeout(timer);
  }, [phase]);
  const style = {
    idle: { transform: "scaleX(0)", opacity: 0, transition: "none" },
    running: { transform: "scaleX(0.85)", opacity: 1, transition: "transform var(--dur-creep) var(--ease-out-quart), opacity var(--dur-feedback) var(--ease-out-quart)" },
    done: { transform: "scaleX(1)", opacity: 0, transition: "transform var(--dur-feedback) var(--ease-out-quart), opacity var(--dur-move) var(--ease-out-quart) var(--dur-feedback)" },
  }[phase];
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] overflow-hidden" aria-hidden="true">
      <div className="h-full origin-left bg-accent" style={style} />
    </div>
  );
}

/** Round "back to top" button once the reader has scrolled a screen or so (desktop; on phones the tab bar does it). */
export function BackToTop() {
  const t = useT();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // Read once a frame at most: the scroll fires far more often than the button can change.
    let frame = 0;
    const update = () => {
      frame = 0;
      setShown(window.scrollY > window.innerHeight * 1.2);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return (
    <button
      type="button"
      aria-label={t("回到顶部", "Back to top")}
      onClick={() => window.scrollTo({ top: 0, behavior: scrollBehavior() })}
      className={`fixed bottom-[max(24px,env(safe-area-inset-bottom))] right-[max(24px,env(safe-area-inset-right))] z-30 hidden size-11 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-[var(--shadow-soft)] transition-[opacity,translate,scale,color] hover:text-ink active:scale-[0.97] lg:flex ${
        shown ? "translate-y-0 opacity-100 duration-(--dur-move)" : "pointer-events-none translate-y-2 opacity-0 duration-(--dur-leave)"
      }`}
    >
      <IconArrowUp size={18} />
    </button>
  );
}
