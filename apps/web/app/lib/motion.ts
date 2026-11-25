// Motion shared by pages: the site's motion language for scripts, repeatable drawings, reduced-motion
// preference, anchor jumps and the section being read.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The lengths and curves of app.css ("Motion"), for scripts that animate (tests/architecture.test.ts compares). */
export const MOTION = {
  feedback: 150,
  move: 240,
  travel: 400,
  leave: 160,
  leaveTravel: 280,
  easeOut: "cubic-bezier(0.25, 1, 0.5, 1)",
  easeDrawer: "cubic-bezier(0.32, 0.72, 0, 1)",
  easeSpring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

/** The ways Presence.tsx brings something in and takes it away (the `fx-*` classes in app.css). */
export type PresenceMotion = "fade" | "pop" | "float" | "collapse" | "sheet";

/** How long each one takes to leave, after which Presence unmounts it. */
export const LEAVE_MS: Record<PresenceMotion, number> = {
  fade: MOTION.leave,
  pop: MOTION.leave,
  float: MOTION.leave,
  collapse: MOTION.leave,
  sheet: MOTION.leaveTravel,
};

/** A drawing's dots growing in: past their size and back, as the site's confirmations do (--ease-spring). */
export const easeOutBack = (p: number) => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2;

/** Repeatable visual noise: the same source or issue keeps the same drawing. */
export function seededRandom(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether the reader asked for reduced motion: still drawings, no animations, instant jumps. */
export const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How the page scrolls for the reader: smoothly, or at once under reduced motion. */
export const scrollBehavior = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");

/** Where an anchor stops after a jump: its scroll margin below the window's top. */
const landing = (el: Element) => parseFloat(getComputedStyle(el).scrollMarginTop) || 0;

/**
 * Scrolls an anchor to the top (its scroll margin keeps it clear of the bar) and puts it in the address
 * without a new history entry: back still leaves the page for the one it came from, at its position.
 */
export function scrollToAnchor(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${id}`);
}

/**
 * A block whose content changes its height in place (a summary opened from two lines to all of it): each time
 * `key` changes it eases from the height it had to the one it has now, instead of jumping; changed again midway,
 * it turns from where it is.
 */
export function useHeightTween(ref: { current: HTMLElement | null }, key: unknown) {
  const last = useRef<number | null>(null);
  // The height it rests at, kept current as the window changes, so a tween never starts from a stale one.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const watch = new ResizeObserver(() => {
      if (!el.getAnimations?.().some((a) => a.id === "height-tween")) last.current = el.getBoundingClientRect().height;
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const running = el.getAnimations?.().find((a) => a.id === "height-tween");
    const shown = el.getBoundingClientRect().height;
    running?.cancel();
    const to = el.getBoundingClientRect().height;
    const from = running ? shown : last.current;
    last.current = to;
    if (from === null || Math.abs(from - to) < 1 || reducedMotion() || !el.animate) return;
    // Shrinking, all of the text stays while the box closes over it (a clamp would cut it at once), and the
    // clamp's ellipsis comes back when it has.
    const shrink = to < from;
    if (shrink) el.style.setProperty("-webkit-line-clamp", "unset");
    const tween = el.animate({ height: [`${from}px`, `${to}px`], overflow: ["clip", "clip"] }, { duration: shrink ? MOTION.leave : MOTION.move, easing: MOTION.easeOut, id: "height-tween" });
    const done = () => el.style.removeProperty("-webkit-line-clamp");
    tween.onfinish = () => {
      tween.cancel();
      done();
    };
    tween.oncancel = done;
  }, [key]);
}

/**
 * Whether `key` has replaced another on screen since this mounted (a board, a time range, a signed-in panel for a
 * signed-out one): what stands in for something fades in where it was (anim-fade-in on the element the key
 * remounts), while what the page opened with, drawn by the server or arriving by navigation, shows at once. From
 * nothing (null) it does not: whatever brings the block in (a panel, a Collapse) does that.
 */
export function useSwapped(key: string | number | null): boolean {
  const [seen, setSeen] = useState({ key, swapped: false });
  if (seen.key !== key) setSeen({ key, swapped: seen.key !== null && key !== null });
  return seen.swapped;
}

/** A link to a place on the page: a plain click scrolls there (scrollToAnchor); modifier clicks keep the browser's way. */
export function jumpTo(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, id: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (!document.getElementById(id)) return;
  e.preventDefault();
  scrollToAnchor(id);
}

/**
 * The section being read, followed while `watch` is on: the last of `ids` whose start has reached its
 * landing, so a jump to a section marks it. Several short sections can share the bottom of the page: there
 * the one just jumped to is marked (scrolling away forgets it), or else the last. `go` jumps to a section.
 */
export function useCurrentSection(ids: string[], watch = true): [string | null, (id: string) => void] {
  const [current, setCurrent] = useState<string | null>(null);
  const jumped = useRef<{ id: string; landed: boolean } | null>(null);
  // While a jump scrolls there, the section jumped to stays marked: the mark goes straight to it instead of
  // stepping through every section passed on the way. The reader scrolling or the scroll settling lets go.
  const heading = useRef<string | null>(null);
  const release = useRef<() => void>(() => {});
  const key = ids.join(" ");
  useEffect(() => {
    if (!watch) return;
    const sections = key.split(" ");
    let settle: ReturnType<typeof setTimeout> | undefined;
    const letGo = () => {
      clearTimeout(settle);
      if (heading.current === null) return;
      heading.current = null;
      update();
    };
    release.current = () => {
      clearTimeout(settle);
      settle = setTimeout(letGo, 1000);
    };
    const update = () => {
      if (heading.current !== null) {
        clearTimeout(settle);
        settle = setTimeout(letGo, 150);
        return setCurrent(heading.current);
      }
      let at: string | null = null;
      for (const id of sections) {
        const el = document.getElementById(id);
        // Fractional positions need one pixel of tolerance.
        if (el && el.getBoundingClientRect().top <= landing(el) + 1) at = id;
      }
      const bottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (bottom) {
        at = jumped.current?.id ?? sections.at(-1)!;
        if (jumped.current) jumped.current.landed = true;
      } else if (jumped.current?.landed) jumped.current = null;
      setCurrent(at);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    for (const type of ["wheel", "touchstart", "keydown"] as const) window.addEventListener(type, letGo, { passive: true });
    const resized = new ResizeObserver(update);
    resized.observe(document.body);
    return () => {
      clearTimeout(settle);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      for (const type of ["wheel", "touchstart", "keydown"] as const) window.removeEventListener(type, letGo);
      resized.disconnect();
    };
  }, [key, watch]);
  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const destination = window.scrollY + el.getBoundingClientRect().top - landing(el);
    jumped.current = destination >= max - 1 ? { id, landed: false } : null;
    heading.current = id;
    release.current();
    setCurrent(id);
    scrollToAnchor(id);
  };
  return [current, go];
}
