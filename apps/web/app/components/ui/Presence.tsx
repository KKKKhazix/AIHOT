// Enter and leave with CSS transitions instead of an animation library (about 35 KB of compressed JavaScript
// on every page). Each motion (app.css, "Motion") is a resting state and a hidden one, `.fx-exit`. An element
// shown is inserted hidden, its style is settled once, and it is let go to rest; an element taken away is sent
// back to hidden and unmounts when that has played out. Both are transitions, so one reversed midway turns
// around from where it is: a menu closed while it opens, or a block toggled twice, never jumps. This works in
// every browser (@starting-style would leave older engines, common in Chinese browsers, with no entrances).
// Content present at the first render never animates in unless `appear` asks it to (an overlay mounted open).
// Reduced motion is handled by the global rule in app.css, and the element then leaves at once.
import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { LEAVE_MS, reducedMotion, type PresenceMotion } from "../../lib/motion";

type Animatable = ReactElement<{ className?: string; inert?: boolean }>;
type Phase = "rest" | "hidden" | "out" | "gone";

const useIsoLayoutEffect = typeof window === "undefined" ? () => {} : useLayoutEffect;

export function Presence({ show, children, motion, appear = false }: {
  show: boolean;
  /** One element; it receives the motion's classes. */
  children: Animatable;
  /** fade: overlays and pictures; pop: a menu from its control; float: a bar over the page; collapse: a block
   * opening in the page (use Collapse); sheet: the bottom sheet. */
  motion: PresenceMotion;
  /** Shown at its first render, it still comes in (sheets and viewers, which never come from the server). */
  appear?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(show ? (appear ? "hidden" : "rest") : "gone");
  const last = useRef<Animatable>(children);
  if (show) last.current = children;
  useIsoLayoutEffect(() => {
    if (show) {
      if (phase === "hidden" || phase === "gone") {
        // Settle the hidden style the element was inserted with, so letting it go is a change to transition.
        void document.body.offsetWidth;
        setPhase("rest");
      } else if (phase === "out") setPhase("rest");
      return;
    }
    if (phase === "gone") return;
    if (phase !== "out") return setPhase(reducedMotion() ? "gone" : "out");
    const timer = setTimeout(() => setPhase("gone"), LEAVE_MS[motion]);
    return () => clearTimeout(timer);
  }, [show, phase, motion]);
  if (!show && phase === "gone") return null;
  const child = show ? children : last.current;
  // Shown from nothing, it renders hidden until the effect above has settled that style and lets it go; shown
  // again while leaving, it heads back to rest from where it is.
  const hidden = !show || phase === "hidden" || phase === "gone";
  // Leaving, it takes no clicks (app.css) and no keyboard focus: what is going cannot be reached.
  return cloneElement(child, { className: `${child.props.className ?? ""} fx-${motion}${hidden ? " fx-exit" : ""}`, inert: show ? child.props.inert : true });
}

/**
 * A block that opens to its natural height and closes to nothing (grid rows 0fr ↔ 1fr), pushing what follows
 * rather than jumping it. Only the height is clipped, so rows inside may still reach past its sides (phone rows
 * run to the screen's edges).
 */
export function Collapse({ open, children, className = "", keep = false }: {
  open: boolean;
  children: ReactNode;
  className?: string;
  /** Closed, the content stays in the page (folded to nothing and inert), for what search engines must read. */
  keep?: boolean;
}) {
  if (keep) {
    return (
      <div inert={!open || undefined} className={`fx-collapse grid grid-cols-[minmax(0,1fr)] ${open ? "" : "fx-exit"} ${className}`}>
        <div className="min-h-0 overflow-x-visible overflow-y-clip">{children}</div>
      </div>
    );
  }
  return (
    <Presence show={open} motion="collapse">
      <div className={`grid grid-cols-[minmax(0,1fr)] ${className}`}>
        <div className="min-h-0 overflow-x-visible overflow-y-clip">{children}</div>
      </div>
    </Presence>
  );
}
