import { useEffect, useRef, useState, type ReactNode } from "react";
import { Presence } from "./Presence";

/** A small dropdown anchored to a trigger; closes on outside click, Escape or choosing an entry. */
export function Menu({ trigger, label, children }: { trigger: ReactNode; label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const firstFocus = useRef<"first" | "last">("first");
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    (firstFocus.current === "last" ? items?.[items.length - 1] : items?.[0])?.focus();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { firstFocus.current = "first"; setOpen(!open); }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          firstFocus.current = e.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
          if (open) {
            const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
            (e.key === "ArrowUp" ? items?.[items.length - 1] : items?.[0])?.focus();
          }
        }}
        className={`inline-flex size-8 items-center justify-center rounded-control transition-colors touch:size-11 ${open ? "bg-bg-sunk text-ink" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
      >
        {trigger}
      </button>
      <div inert={!open} aria-hidden={!open || undefined}>
        <Presence show={open} enter="anim-drop-in" exit="anim-drop-out" duration={140}>
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={(e) => {
              if (e.key === "Tab") { setOpen(false); return; }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
              const current = items.indexOf(document.activeElement as HTMLElement);
              const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
                : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}
            className="absolute top-[calc(100%+8px)] z-50 min-w-[168px] overflow-hidden rounded-tile border border-line bg-raised py-1 shadow-[var(--shadow-pop)] right-0 origin-top-right"
          >
            {children(close)}
          </div>
        </Presence>
      </div>
    </div>
  );
}

/** One entry of a Menu (a button or a link). */
export function MenuItem({ icon, children, onSelect, href, download }: { icon?: ReactNode; children: ReactNode; onSelect?: () => void; href?: string; download?: boolean }) {
  const cls = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink focus-visible:bg-bg-sunk focus-visible:text-ink";
  const inner = (
    <>
      {icon && <span className="text-ink-4">{icon}</span>}
      {children}
    </>
  );
  if (href) {
    return (
      <a role="menuitem" tabIndex={-1} href={href} download={download} onClick={onSelect} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button role="menuitem" tabIndex={-1} type="button" onClick={onSelect} className={cls}>
      {inner}
    </button>
  );
}
