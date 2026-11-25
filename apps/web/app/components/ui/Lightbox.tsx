import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Presence } from "./Presence";
import { useModal } from "./modal";
import { IconArrowLeft, IconArrowRight, IconClose } from "../icons";
import { useT } from "../../lib/i18n";
import { MOTION } from "../../lib/motion";

export interface LightboxImage {
  src: string;
  alt?: string | null;
}

/**
 * Pictures shown full size over the page. While open, keyboard focus stays in the viewer (Tab moves
 * between its buttons), the page behind does not scroll, Escape closes it and the arrow keys move
 * between pictures; closing puts focus back where it was. On touch screens a picture follows the finger:
 * sideways to the next or previous one, down to close; two fingers zoom as the browser does.
 * A picture grows out of the thumbnail it was opened from (`origin`) and shrinks back into the one showing when
 * it closes; stepping brings the next picture in from the side it was asked for.
 */
export function Lightbox({ images, index, onIndex, onClose, origin }: {
  images: LightboxImage[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** The element on the page each picture was opened from. */
  origin?: (index: number) => Element | null | undefined;
}) {
  const t = useT();
  const open = index !== null && !!images[index];
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const state = useRef({ index, count: images.length, onIndex, onClose });
  state.current = { index, count: images.length, onIndex, onClose };
  // Where the picture grows from and returns to, read as it is shown (before the viewer covers the page) so the
  // entrance starts there; and which way the last step went, so the next picture comes in from that side.
  const stepDirection = useRef(0);
  const from = useRef<{ index: number | null; at: string; step: number }>({ index: null, at: "50% 50%", step: 0 });
  if (index !== from.current.index) {
    const rect = index === null ? null : origin?.(index)?.getBoundingClientRect();
    const seen = rect && rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    const step = from.current.index === null || index === null ? 0 : stepDirection.current;
    from.current = { index, at: seen ? `${rect.left + rect.width / 2}px ${rect.top + rect.height / 2}px` : "50% 50%", step };
  }
  const go = (to: number, direction: number) => {
    stepDirection.current = direction;
    state.current.onIndex(to);
  };

  // Opened again while the last one is still leaving: whatever its drag left behind is put back.
  useLayoutEffect(() => {
    if (!open) return;
    dialog.current?.style.setProperty("--lightbox-origin", from.current.at);
    if (dialog.current) {
      dialog.current.style.backgroundColor = "";
      dialog.current.style.transition = "";
    }
    if (img.current) img.current.style.translate = "";
  }, [open]);

  useModal({
    open,
    panel: dialog,
    initialFocus: closeButton,
    onClose,
    onKeyDown: (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const { index: at, count } = state.current;
      if (at !== null && count > 1) go((at + (e.key === "ArrowRight" ? 1 : -1) + count) % count, e.key === "ArrowRight" ? 1 : -1);
      e.preventDefault();
    },
  });

  // Touch: follow one finger, then step, close or snap back. A drag is not also a tap that closes.
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; axis: "x" | "y" | null; moved: boolean; t: number; vx: number; vy: number } | null>(null);
  const suppressTap = useRef(false);
  const zoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
  const place = (dx: number, dy: number, animate: boolean) => {
    const el = img.current;
    const backdrop = dialog.current;
    if (!el || !backdrop) return;
    el.style.transition = animate ? "" : "none";
    el.style.translate = dx || dy ? `${dx}px ${dy}px` : "";
    // The backdrop clears with the drag and darkens back with the picture, not in a single frame; let go, it fades
    // out as the viewer's own closing does (app.css .fx-fade).
    backdrop.style.transition = animate ? `background-color ${MOTION.move}ms ${MOTION.easeOut}, opacity var(--dur-leave) var(--ease-out-quart)` : "none";
    backdrop.style.backgroundColor = dy > 0 ? `rgba(0, 0, 0, ${Math.max(0.3, 0.85 - dy / 600)})` : "";
  };
  const cancelDrag = () => {
    suppressTap.current = true;
    drag.current = null;
    place(0, 0, true);
  };
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1 || zoomed()) return cancelDrag();
    suppressTap.current = false;
    drag.current = e.target instanceof Element && e.target.closest("button") ? null : { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, dx: 0, dy: 0, axis: null, moved: false, t: performance.now(), vx: 0, vy: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length !== 1 || zoomed()) return cancelDrag();
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dx = e.touches[0]!.clientX - d.x;
    const dy = e.touches[0]!.clientY - d.y;
    const dt = Math.max(1, now - d.t);
    d.vx = (dx - d.dx) / dt;
    d.vy = (dy - d.dy) / dt;
    d.t = now;
    d.dx = dx;
    d.dy = dy;
    if (!d.axis && Math.hypot(d.dx, d.dy) > 8) d.axis = Math.abs(d.dx) > Math.abs(d.dy) ? "x" : "y";
    if (!d.axis) return;
    d.moved = true;
    if (d.axis === "x" && images.length > 1) place(d.dx, 0, false);
    else if (d.axis === "y") place(0, Math.max(0, d.dy), false);
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length || zoomed()) return cancelDrag();
    const d = drag.current;
    if (!d?.moved) return;
    suppressTap.current = true;
    drag.current = null;
    const { index: at, count, onClose: close } = state.current;
    // Far enough, or flicked: a quick throw counts even when it travelled only a little.
    const flicked = performance.now() - d.t < 100;
    if (d.axis === "x" && count > 1 && at !== null && (Math.abs(d.dx) > 60 || (flicked && Math.abs(d.vx) > 0.5 && Math.abs(d.dx) > 16))) {
      // The next picture takes over from the finger, coming in from the side it was pulled from.
      place(0, 0, false);
      go((at + (d.dx < 0 ? 1 : -1) + count) % count, d.dx < 0 ? 1 : -1);
    } else if (d.axis === "y" && (d.dy > 110 || (flicked && d.vy > 0.6 && d.dy > 16))) {
      // Thrown down: it goes on down and shrinks away where it is, the way it was thrown, rather than back up to
      // its thumbnail; the backdrop clears as it does.
      const el = img.current;
      const box = el?.getBoundingClientRect();
      if (el && box && dialog.current) {
        dialog.current.style.setProperty("--lightbox-origin", `${box.left + box.width / 2}px ${box.top + box.height / 2}px`);
        // The drag held every transition still; the viewer's fade out takes over again.
        dialog.current.style.transition = "";
        el.style.transition = "";
        el.style.translate = `0 ${Math.max(0, d.dy) + 80}px`;
      }
      close();
    } else {
      place(0, 0, true);
    }
  };
  const tappedAfterDrag = () => {
    const moved = suppressTap.current;
    suppressTap.current = false;
    drag.current = null;
    return moved;
  };

  const current = open ? images[index!]! : null;
  const many = images.length > 1;
  const nav = "absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white press hover:bg-white/20";
  if (typeof document === "undefined") return null;
  return createPortal(
    <Presence show={open} motion="fade" appear>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={many && index !== null ? t(`图片 ${index + 1} / ${images.length}`, `Image ${index + 1} of ${images.length}`) : t("图片", "Image")}
        onClick={() => {
          if (!tappedAfterDrag()) onClose();
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={cancelDrag}
        style={{ "--lightbox-origin": from.current.at, "--lightbox-from-x": `${from.current.step * 48}px` } as CSSProperties}
        className="fixed inset-0 z-[80] cursor-zoom-out touch-pinch-zoom bg-black/85"
      >
        <div className="lightbox-stage absolute inset-0 grid place-items-center p-4 sm:p-10">
          {current && (
            <img ref={img} key={current.src} src={current.src} decoding="async" alt={current.alt ?? ""} className={`lightbox-img min-h-0 min-w-0 max-h-[calc(100dvh-5rem)] max-w-full rounded-control object-contain shadow-2xl ${from.current.step ? "lightbox-step" : ""}`} />
          )}
        </div>
        <button ref={closeButton} type="button" aria-label={t("关闭", "Close")} onClick={(e) => { e.stopPropagation(); onClose(); }} className="absolute right-[max(16px,env(safe-area-inset-right))] top-[max(16px,env(safe-area-inset-top))] grid size-11 place-items-center rounded-full bg-white/10 text-white press hover:bg-white/20">
          <IconClose size={18} />
        </button>
        {many && index !== null && (
          <>
            <button type="button" aria-label={t("上一张", "Previous image")} onClick={(e) => { e.stopPropagation(); go((index - 1 + images.length) % images.length, -1); }} className={`${nav} left-[max(12px,env(safe-area-inset-left))] sm:left-5`}>
              <IconArrowLeft size={18} />
            </button>
            <button type="button" aria-label={t("下一张", "Next image")} onClick={(e) => { e.stopPropagation(); go((index + 1) % images.length, 1); }} className={`${nav} right-[max(12px,env(safe-area-inset-right))] sm:right-5`}>
              <IconArrowRight size={18} />
            </button>
            <span className="num pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-2.5 py-0.5 text-ui-caption text-white/85">
              {index + 1} / {images.length}
            </span>
          </>
        )}
      </div>
    </Presence>, document.body
  );
}
