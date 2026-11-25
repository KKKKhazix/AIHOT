// The phone's bottom sheet: slides up over a dimmed page, follows the finger down from its handle (or
// from its content once that is scrolled to the top) and closes when let go far or fast enough. While
// open the page behind does not scroll, focus stays inside, and Escape or the backdrop closes it.
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Presence } from "./Presence";
import { IconCheck, IconClose } from "../icons";
import { useModal } from "./modal";
import { MOTION } from "../../lib/motion";
import { useT } from "../../lib/i18n";

const CLOSE_DISTANCE = 110;
const CLOSE_VELOCITY = 0.6; // px per ms

/** A choice listed in a sheet: large type in a full-height row, the one in use in accent. */
export const sheetChoice = (on: boolean) => `flex h-12 items-center justify-between text-ui-body-lg transition-colors active:bg-bg-sunk ${on ? "font-semibold text-accent" : "text-ink"}`;

/** The tick that ends the choice in use. */
export const ChoiceTick = () => <IconCheck size={19} strokeWidth={2.2} />;

export function Sheet({ open, onClose, title, children, label, centered = false }: {
  open: boolean;
  onClose: () => void;
  /** From sm up, a dialog in the middle of the screen instead (the share poster). */
  centered?: boolean;
  title?: ReactNode;
  children: ReactNode;
  /** Accessible name when there is no visible title. */
  label?: string;
}) {
  const t = useT();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useModal({ open, panel, onClose });
  // Opened again while it is still leaving, the panel rides back up from wherever the last drag let it go.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    el.style.translate = "";
    el.style.transition = "";
    const shade = el.previousElementSibling as HTMLElement | null;
    if (shade) shade.style.opacity = shade.style.transition = "";
  }, [open]);

  // Dragging down: from the handle and header at any time, from the content when it is at its top.
  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    const content = body.current;
    const grip = handle.current;
    if (!el || !grip) return;
    const shade = el.previousElementSibling as HTMLElement | null;
    // A centred dialog (from sm) stays where it is: only the bottom sheet is pulled down.
    const fixed = () => centered && matchMedia("(min-width: 641px)").matches;
    // The page behind clears as the panel goes down.
    const dim = (moved: number) => {
      if (shade) shade.style.opacity = String(Math.max(0, 1 - moved / Math.max(1, el.offsetHeight)));
    };
    let drag: { y0: number; y: number; t: number; v: number } | null = null;
    const begin = (y: number) => {
      // Picked up mid-flight (still riding in, or springing back), it is held where it is and follows from there.
      const rest = el.parentElement!.getBoundingClientRect().bottom - el.offsetHeight;
      const at = Math.max(0, el.getBoundingClientRect().top - rest);
      drag = { y0: y - at, y, t: performance.now(), v: 0 };
      el.style.transition = "none";
      el.style.translate = `0 ${at}px`;
      if (shade) shade.style.transition = "none";
      dim(at);
    };
    const follow = (y: number) => {
      if (!drag) return;
      const now = performance.now();
      drag.v = (y - drag.y) / Math.max(1, now - drag.t);
      drag.y = y;
      drag.t = now;
      el.style.translate = `0 ${Math.max(0, y - drag.y0)}px`;
      dim(Math.max(0, y - drag.y0));
    };
    const release = (cancelled = false) => {
      if (!drag) return;
      const moved = drag.y - drag.y0;
      const fast = drag.v > CLOSE_VELOCITY && performance.now() - drag.t < 100;
      const speed = performance.now() - drag.t < 100 ? drag.v : 0;
      drag = null;
      // Let go: it carries on down and away from where the finger left it, at about the finger's speed (the drawer
      // curve starts at about twice its average), or springs back up into place.
      if (shade) shade.style.transition = "";
      if (!cancelled && (moved > CLOSE_DISTANCE || (fast && moved > 12))) {
        const rest = Math.max(0, el.offsetHeight - moved);
        const ms = speed > 0 ? Math.min(MOTION.leaveTravel, Math.max(MOTION.leave, (2 * rest) / speed)) : MOTION.leaveTravel;
        const away = `${Math.round(ms)}ms ${MOTION.easeDrawer}`;
        el.style.transition = `translate ${away}`;
        el.style.translate = "0 100%";
        if (shade) {
          shade.style.transition = `opacity ${away}`;
          shade.style.opacity = "0";
        }
        close.current();
      } else {
        // A short way back: it settles at the speed of a part of the page, not of a whole sheet riding in.
        el.style.transition = `translate ${MOTION.move}ms ${MOTION.easeOut}`;
        el.style.translate = "";
        el.addEventListener("transitionend", () => { el.style.transition = ""; }, { once: true });
        if (shade) shade.style.opacity = "";
      }
    };
    const onGripUp = () => release();
    const cancel = () => release(true);
    const onGripDown = (e: PointerEvent) => {
      if (!e.isPrimary) return cancel();
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest("button, a")) return;
      if (fixed()) return;
      grip.setPointerCapture(e.pointerId);
      begin(e.clientY);
    };
    const onGripMove = (e: PointerEvent) => follow(e.clientY);
    grip.addEventListener("pointerdown", onGripDown);
    grip.addEventListener("pointermove", onGripMove);
    grip.addEventListener("pointerup", onGripUp);
    grip.addEventListener("pointercancel", cancel);

    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return onTouchCancel();
      touchY = content && content.scrollTop <= 0 && !fixed() ? e.touches[0]!.clientY : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return onTouchCancel();
      if (touchY === null) return;
      const y = e.touches[0]!.clientY;
      if (!drag) {
        if (y - touchY < 6) {
          if (y < touchY) touchY = null; // scrolling the content up: leave it to the browser
          return;
        }
        begin(touchY);
      }
      e.preventDefault();
      follow(y);
    };
    const onTouchEnd = () => {
      touchY = null;
      release();
    };
    const onTouchCancel = () => {
      touchY = null;
      cancel();
    };
    content?.addEventListener("touchstart", onTouchStart, { passive: true });
    content?.addEventListener("touchmove", onTouchMove, { passive: false });
    content?.addEventListener("touchend", onTouchEnd);
    content?.addEventListener("touchcancel", onTouchCancel);
    return () => {
      grip.removeEventListener("pointerdown", onGripDown);
      grip.removeEventListener("pointermove", onGripMove);
      grip.removeEventListener("pointerup", onGripUp);
      grip.removeEventListener("pointercancel", cancel);
      content?.removeEventListener("touchstart", onTouchStart);
      content?.removeEventListener("touchmove", onTouchMove);
      content?.removeEventListener("touchend", onTouchEnd);
      content?.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [open, centered]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <Presence show={open} motion="sheet" appear>
      <div className={`fixed inset-0 z-[70] flex flex-col justify-end ${centered ? "sm:items-center sm:justify-center sm:p-6" : ""}`}>
        <button type="button" aria-label={t("关闭", "Close")} tabIndex={-1} onClick={onClose} className="sheet-backdrop absolute inset-0 cursor-default bg-[rgba(8,14,15,0.42)]" />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-label={title ? undefined : label}
          tabIndex={-1}
          className={`sheet-panel relative mx-auto flex max-h-[88dvh] w-full max-w-[640px] flex-col rounded-t-sheet bg-surface shadow-[0_-12px_40px_rgba(0,0,0,0.16)] outline-none ${centered ? "sheet-centered sm:w-auto sm:min-w-[400px] sm:rounded-sheet sm:pb-2" : ""}`}
        >
          <div ref={handle} className="touch-none select-none">
            <span aria-hidden="true" className={`mx-auto mt-[7px] block h-[5px] w-9 rounded-full bg-line-strong ${centered ? "sm:invisible" : ""}`} />
            {title && (
              <div className="flex min-h-12 items-center gap-3 pl-5 pr-2">
                <h2 id={titleId} className="min-w-0 flex-1 text-ui-subheading-sm font-bold leading-snug text-ink">
                  {title}
                </h2>
                <button type="button" aria-label={t("关闭", "Close")} onClick={onClose} className="group/close press grid size-11 shrink-0 place-items-center rounded-full text-ink-3 hover:text-ink">
                  <span className="grid size-[30px] place-items-center rounded-full bg-bg-sunk transition-colors group-hover/close:bg-bg-muted dark:bg-bg-muted dark:group-hover/close:bg-line-strong">
                    <IconClose size={15} strokeWidth={2} />
                  </span>
                </button>
              </div>
            )}
          </div>
          <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(16px,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </div>
      </div>
    </Presence>,
    document.body,
  );
}
