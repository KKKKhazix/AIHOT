import { useEffect, useRef, useState, type ReactNode } from "react";
import { Presence } from "./Presence";

/** A small dropdown anchored to a trigger; closes on outside click, Escape or choosing an entry. */
export function Menu({ trigger, label, children }: { trigger: ReactNode; label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
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
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`inline-flex size-8 items-center justify-center rounded-control transition-colors ${open ? "bg-bg-sunk text-ink" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
      >
        {trigger}
      </button>
      <Presence show={open} enter="anim-drop-in" exit="anim-drop-out" duration={140}>
        <div
          role="menu"
          className="absolute top-10 z-50 min-w-[168px] overflow-hidden rounded-tile border border-line bg-raised py-1 shadow-[var(--shadow-pop)] right-0 origin-top-right"
        >
          {children(() => setOpen(false))}
        </div>
      </Presence>
    </div>
  );
}

/** One entry of a Menu (a button or a link). */
export function MenuItem({ icon, children, onSelect, href, download }: { icon?: ReactNode; children: ReactNode; onSelect?: () => void; href?: string; download?: boolean }) {
  const cls = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink";
  const inner = (
    <>
      {icon && <span className="text-ink-4">{icon}</span>}
      {children}
    </>
  );
  if (href) {
    return (
      <a role="menuitem" href={href} download={download} onClick={onSelect} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button role="menuitem" type="button" onClick={onSelect} className={cls}>
      {inner}
    </button>
  );
}
