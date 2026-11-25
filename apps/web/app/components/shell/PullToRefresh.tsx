// The site opened from the phone's home screen has no browser bar, so no reload: there, pulling down at the
// top of a page reloads its data, with the ring mark turning as it is pulled and spinning while it loads.
// In a browser tab nothing is listened for, and the browser's own pull-to-refresh stays in charge.
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { RingMark } from "@aihot/site/brand/Logo.tsx";
import { isPhone } from "./screens";

const TRIGGER = 64; // pulled this far (after resistance), letting go reloads
const MAX = 120; // the mark never comes further than this, however far the finger goes
const GIVE = 0.7; // at first the mark moves this much of the finger's way, then ever less (a rubber band)

function standalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function PullToRefresh() {
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  const holder = useRef<HTMLDivElement>(null);
  const turner = useRef<HTMLSpanElement>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // A listener that may hold scrolling back costs every scroll, so it exists only where it is used.
    if (!standalone()) return;
    const el = holder.current;
    const mark = turner.current;
    if (!el || !mark) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let distance = 0;
    let busy = false;
    // The mark follows the finger directly (no transition, no re-render per move); let go, it eases home.
    const place = (pull: number, follow: boolean) => {
      el.style.transition = follow ? "none" : "";
      el.style.translate = `0 ${pull - 44}px`;
      el.style.opacity = pull === 0 && !busy ? "0" : "1";
      // Followed, the mark turns with the finger; let go, it turns home with the bar rather than snapping back.
      mark.style.transition = follow ? "none" : "";
      if (busy) return;
      const progress = Math.min(1, pull / TRIGGER);
      // It turns with the pull and gives a small nod once letting go would reload.
      mark.style.rotate = `${progress * 300}deg`;
      mark.style.opacity = String(0.35 + progress * 0.65);
      mark.style.scale = progress >= 1 ? "1.08" : "";
    };
    const onCancel = () => {
      start = null;
      pulling = false;
      distance = 0;
      if (!busy) place(0, false);
    };
    const onStart = (e: TouchEvent) => {
      onCancel();
      if (busy || e.touches.length !== 1 || window.scrollY > 0 || !isPhone()) return;
      // Not inside a sheet, the search or anything else laid over the page (they hold the page still).
      if (document.documentElement.style.overflow === "hidden" || (e.target instanceof Element && e.target.closest('[role="dialog"]'))) return;
      start = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
      pulling = false;
      distance = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return onCancel();
      if (!start) return;
      const dy = e.touches[0]!.clientY - start.y;
      const dx = e.touches[0]!.clientX - start.x;
      if (!pulling) {
        if (dy < -4 || Math.abs(dx) > Math.max(10, dy)) start = null; // scrolling or swiping: not ours
        if (!start || dy < 8 || window.scrollY > 0) return;
        pulling = true;
      }
      e.preventDefault(); // the page stays put while the mark comes down
      distance = MAX * (1 - Math.exp((-Math.max(0, dy - 8) * GIVE) / MAX));
      place(distance, true);
    };
    const onEnd = () => {
      if (!start) return;
      start = null;
      if (!pulling) return;
      pulling = false;
      if (distance < TRIGGER) return place(0, false);
      // Reloading: the mark settles at the trigger and spins on from the angle it was pulled to.
      place(TRIGGER, false);
      mark.style.scale = "";
      busy = true;
      setLoading(true);
      void revalidate
        .current()
        .catch(() => {})
        .finally(() => {
          busy = false;
          setLoading(false);
          place(0, false);
        });
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, []);

  return (
    <div
      ref={holder}
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--bar-h)+env(safe-area-inset-top))] z-30 flex -translate-y-11 justify-center opacity-0 transition-[opacity,translate] duration-(--dur-move) lg:hidden"
    >
      <span className="grid size-9 place-items-center rounded-full bg-surface text-accent shadow-[var(--shadow-soft)] ring-1 ring-line-soft">
        <span ref={turner} className="flex transition-[scale,rotate,opacity] duration-(--dur-move)">
          <RingMark className="size-[18px]" spinning={loading} />
        </span>
      </span>
    </div>
  );
}
