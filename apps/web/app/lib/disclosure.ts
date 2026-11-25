// Folded sections (<details class="disclosure">) open and close to their height, in every browser the same way (CSS
// can animate to an auto height only in Chromium). Their content stays in the page's HTML, and before the page's
// script runs they simply open and close.
import { useEffect } from "react";
import { MOTION, reducedMotion } from "./motion";

const running = new WeakMap<HTMLDetailsElement, Animation>();

function toggle(details: HTMLDetailsElement, summary: HTMLElement) {
  const was = running.get(details);
  // Turned around midway: start from the height it has reached.
  const from = details.getBoundingClientRect().height;
  was?.cancel();
  const opening = was ? details.dataset.closing === "1" : !details.open;
  details.dataset.closing = opening ? "" : "1";
  if (opening) details.open = true;
  details.style.overflow = "clip";
  const run = (to: number) => {
    details.style.height = "";
    const animation = details.animate({ height: [`${from}px`, `${to}px`] }, { duration: opening ? MOTION.move : MOTION.leave, easing: MOTION.easeOut });
    running.set(details, animation);
    animation.onfinish = () => {
      running.delete(details);
      if (!opening) details.open = false;
      details.dataset.closing = "";
      details.style.overflow = "";
    };
  };
  if (!opening) {
    const box = getComputedStyle(details);
    return run(summary.getBoundingClientRect().bottom - details.getBoundingClientRect().top + parseFloat(box.paddingBottom) + parseFloat(box.borderBottomWidth));
  }
  // Content a page renders only once the fold is open (a month's issues) arrives a frame or two later: it is held
  // closed until there is something to open to, then opens, rather than opening onto nothing and jumping.
  const grow = (tries: number) => {
    if (details.dataset.closing === "1") return; // closed again while it waited
    details.style.height = "";
    const to = details.getBoundingClientRect().height;
    if (to - from >= 1 || tries === 0) return run(to);
    details.style.height = `${from}px`;
    requestAnimationFrame(() => grow(tries - 1));
  };
  grow(6);
}

/**
 * Opens or closes a fold from elsewhere (a link to it, the page choosing it) the way its summary would. A fold whose
 * `open` React holds follows through its onToggle.
 */
export function foldTo(details: HTMLDetailsElement | null, open: boolean) {
  if (!details) return;
  const going = running.has(details) ? details.dataset.closing !== "1" : details.open;
  if (going === open) return;
  const summary = details.querySelector(":scope > summary");
  if (reducedMotion() || !details.animate || !(summary instanceof HTMLElement)) {
    details.open = open;
    return;
  }
  toggle(details, summary);
}

/** In the root: lets every .disclosure in the page fold smoothly. */
export function useDisclosureMotion() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || reducedMotion() || !(e.target instanceof Element)) return;
      const summary = e.target.closest("summary");
      const details = summary?.parentElement;
      if (!summary || !(details instanceof HTMLDetailsElement) || !details.classList.contains("disclosure") || !details.animate) return;
      // Links and buttons inside the summary keep their own click.
      if (e.target.closest("a, button")?.closest("summary") === summary) return;
      e.preventDefault();
      toggle(details, summary);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
