// The site opened from the phone's home screen has no browser bar, so no reload: there, pulling down at the
// top of a page reloads its data, with the ring mark turning as it is pulled and spinning while it loads.
// In a browser tab nothing is listened for, and the browser's own pull-to-refresh stays in charge.
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { RingMark } from "@aihot/industry/brand/Logo.tsx";
import { isPhone } from "./screens";

const TRIGGER = 64; // pulled this far (after resistance), letting go reloads
const MAX = 96;

function standalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function PullToRefresh() {
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // A listener that may hold scrolling back costs every scroll, so it exists only where it is used.
    if (!standalone()) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let distance = 0;
    let busy = false;
    const onCancel = () => {
      start = null;
      pulling = false;
      distance = 0;
      setDragging(false);
      if (!busy) setPull(0);
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
        setDragging(true);
      }
      e.preventDefault(); // the page stays put while the mark comes down
      distance = Math.min(MAX, Math.max(0, dy - 8) * 0.55);
      setPull(distance);
    };
    const onEnd = () => {
      if (!start) return;
      start = null;
      if (!pulling) return;
      pulling = false;
      setDragging(false);
      if (distance < TRIGGER) return setPull(0);
      busy = true;
      setLoading(true);
      setPull(TRIGGER);
      void revalidate
        .current()
        .catch(() => {})
        .finally(() => {
          busy = false;
          setLoading(false);
          setPull(0);
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

  const progress = Math.min(1, pull / TRIGGER);
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-x-0 top-[calc(var(--bar-h)+env(safe-area-inset-top))] z-30 flex justify-center lg:hidden ${dragging ? "" : "transition-[transform,opacity] duration-300 ease-[var(--ease-out-quart)]"}`}
      style={{ transform: `translateY(${pull - 44}px)`, opacity: pull === 0 && !loading ? 0 : 1 }}
    >
      <span className="grid size-9 place-items-center rounded-full bg-surface text-accent shadow-[var(--shadow-soft)] ring-1 ring-line-soft">
        <span className="flex" style={loading ? undefined : { transform: `rotate(${progress * 300}deg)`, opacity: 0.35 + progress * 0.65 }}>
          <RingMark className="size-[18px]" spinning={loading} />
        </span>
      </span>
    </div>
  );
}
