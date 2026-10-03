import { useRef } from "react";
import { createPortal } from "react-dom";
import { Presence } from "./Presence";
import { useModal } from "./modal";
import { IconArrowLeft, IconArrowRight, IconClose } from "../icons";

export interface LightboxImage {
  src: string;
  alt?: string | null;
}

/**
 * Pictures shown full size over the page. While open, keyboard focus stays in the viewer (Tab moves
 * between its buttons), the page behind does not scroll, Escape closes it and the arrow keys move
 * between pictures; closing puts focus back where it was. On touch screens a picture follows the finger:
 * sideways to the next or previous one, down to close; two fingers zoom as the browser does.
 */
export function Lightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const open = index !== null && !!images[index];
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const state = useRef({ index, count: images.length, onIndex, onClose });
  state.current = { index, count: images.length, onIndex, onClose };

  useModal({
    open,
    panel: dialog,
    initialFocus: closeButton,
    onClose,
    onKeyDown: (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const { index: at, count, onIndex: go } = state.current;
      if (at !== null && count > 1) go((at + (e.key === "ArrowRight" ? 1 : -1) + count) % count);
      e.preventDefault();
    },
  });

  // Touch: follow one finger, then step, close or snap back. A drag is not also a tap that closes.
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; axis: "x" | "y" | null; moved: boolean } | null>(null);
  const suppressTap = useRef(false);
  const zoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
  const place = (dx: number, dy: number, animate: boolean) => {
    const el = img.current;
    const backdrop = dialog.current;
    if (!el || !backdrop) return;
    el.style.transition = animate ? "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)" : "none";
    el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
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
    drag.current = e.target instanceof Element && e.target.closest("button") ? null : { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, dx: 0, dy: 0, axis: null, moved: false };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length !== 1 || zoomed()) return cancelDrag();
    const d = drag.current;
    if (!d) return;
    d.dx = e.touches[0]!.clientX - d.x;
    d.dy = e.touches[0]!.clientY - d.y;
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
    const { index: at, count, onIndex: go, onClose: close } = state.current;
    if (d.axis === "x" && count > 1 && at !== null && Math.abs(d.dx) > 60) {
      place(0, 0, false);
      go((at + (d.dx < 0 ? 1 : -1) + count) % count);
    } else if (d.axis === "y" && d.dy > 110) {
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
  const nav = "absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20";
  if (typeof document === "undefined") return null;
  return createPortal(
    <Presence show={open} enter="anim-fade-in" exit="anim-fade-out" duration={160}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={many && index !== null ? `图片 ${index + 1} / ${images.length}` : "图片"}
        onClick={() => {
          if (!tappedAfterDrag()) onClose();
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={cancelDrag}
        className="fixed inset-0 z-[80] grid cursor-zoom-out touch-pinch-zoom place-items-center bg-black/85 p-4 sm:p-10"
      >
        {current && (
          <img ref={img} key={current.src} src={current.src} decoding="async" alt={current.alt ?? ""} className="lightbox-img anim-zoom-in min-h-0 min-w-0 max-h-[calc(100dvh-5rem)] max-w-full rounded-control object-contain shadow-2xl" />
        )}
        <button ref={closeButton} type="button" aria-label="关闭" onClick={(e) => { e.stopPropagation(); onClose(); }} className="absolute right-[max(16px,env(safe-area-inset-right))] top-[max(16px,env(safe-area-inset-top))] grid size-11 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20">
          <IconClose size={18} />
        </button>
        {many && index !== null && (
          <>
            <button type="button" aria-label="上一张" onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + images.length) % images.length); }} className={`${nav} left-[max(12px,env(safe-area-inset-left))] sm:left-5`}>
              <IconArrowLeft size={18} />
            </button>
            <button type="button" aria-label="下一张" onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % images.length); }} className={`${nav} right-[max(12px,env(safe-area-inset-right))] sm:right-5`}>
              <IconArrowRight size={18} />
            </button>
            <span className="num pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-2.5 py-0.5 text-[12px] text-white/85">
              {index + 1} / {images.length}
            </span>
          </>
        )}
      </div>
    </Presence>, document.body
  );
}
