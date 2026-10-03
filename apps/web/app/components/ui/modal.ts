// Shared lifecycle for the sheet, search and image viewer: only the top layer handles the keyboard,
// and scrolling stays locked until the last layer closes, including when one dialog replaces another.
import { useEffect, useRef, type RefObject } from "react";

const layers: object[] = [];
let pageOverflow = "";

export function useModal({ open, panel, onClose, initialFocus, returnFocus, onKeyDown }: {
  open: boolean;
  panel: RefObject<HTMLElement | null>;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  /** Search focuses during the tap to bring up iOS's keyboard, so captures its opener before that. */
  returnFocus?: RefObject<HTMLElement | null>;
  onKeyDown?: (event: KeyboardEvent) => void;
}) {
  const current = useRef({ onClose, onKeyDown });
  current.current = { onClose, onKeyDown };
  useEffect(() => {
    if (!open || !panel.current) return;
    const element = panel.current;
    element.inert = false;
    const opener = returnFocus ? returnFocus.current : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const layer = {};
    if (!layers.length) {
      pageOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
    }
    layers.push(layer);
    if (!element.contains(document.activeElement)) (initialFocus?.current ?? element).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (layers.at(-1) !== layer) return;
      if (event.key === "Escape") {
        event.preventDefault();
        current.current.onClose();
      } else if (event.key === "Tab") {
        const focusable = [...element.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')]
          .filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && !node.closest("[inert]") && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
        event.preventDefault();
        if (!focusable.length) return element.focus({ preventScroll: true });
        const at = focusable.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : (at + 1) % focusable.length;
        focusable[next]!.focus();
      } else current.current.onKeyDown?.(event);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Presence keeps an exiting layer mounted briefly; it must no longer accept focus then.
      element.inert = true;
      const wasTop = layers.at(-1) === layer;
      layers.splice(layers.indexOf(layer), 1);
      if (!layers.length) document.documentElement.style.overflow = pageOverflow;
      if (wasTop && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, panel, initialFocus, returnFocus]);
}
