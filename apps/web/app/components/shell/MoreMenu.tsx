import { useEffect, useRef, useState, type ReactNode } from "react";
import { Presence } from "../ui/Presence";
import { ThemeSwitch } from "./ThemeSwitch";
import { FontSelect } from "./FontSelect";
import { LanguageSwitch } from "./LanguageSwitch";
import { ENGLISH } from "@aihot/contracts/english";
import { webModules } from "../../site-modules";
import { useT } from "../../lib/i18n";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-3 touch:min-h-11">
      <span className="min-w-0 flex-1 text-ui-label text-ink-2">{label}</span>
      {children}
    </div>
  );
}

/**
 * 更多 at the foot of the desktop sidebar: one word, no icon (product decision 2026-11-24), opening a small
 * panel that holds the reader's account, the appearance and font settings and, on a site with an English edition,
 * the language switch, which the phone keeps under 我的.
 * The panel rises from the foot row it belongs to and is placed on the page, not in the sidebar, so a short
 * window (where the sidebar scrolls) does not cut it off; any scroll or resize closes it rather than leave it
 * behind the row it came from.
 */
export function MoreMenu({ anchor }: { anchor: () => HTMLElement | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const Account = webModules().find((m) => m.account)?.account;

  const toggle = () => {
    if (open) return setOpen(false);
    const r = (anchor() ?? triggerRef.current)?.getBoundingClientRect();
    if (r) setAt({ left: r.left, bottom: window.innerHeight - r.top + 8 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onMove = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className={`flex h-[34px] min-w-0 flex-1 items-center justify-center rounded-full border border-line text-ui-caption-lg transition-colors touch:h-11 ${
          open ? "bg-bg-sunk text-ink" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"
        }`}
      >
        {t("更多", "More")}
      </button>
      <div inert={!open} aria-hidden={!open || undefined}>
        <Presence show={open} enter="anim-fade-in" exit="anim-fade-out" duration={160}>
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("更多", "More")}
            style={at ? { left: at.left, bottom: at.bottom } : undefined}
            className="fixed z-50 w-[236px] overflow-hidden rounded-tile border border-line bg-raised py-1 shadow-[var(--shadow-pop)]"
          >
            {Account && (
              <>
                {/* Its row opens the account panel and the menu steps aside. Focus moves to 更多 first, before the
                    panel opens, so closing the panel brings it back there rather than to a row that is gone. */}
                <div onClickCapture={() => { triggerRef.current?.focus(); setOpen(false); }}>
                  <Account place="menu" />
                </div>
                <div className="my-1 h-px bg-line-soft" />
              </>
            )}
            <Row label={t("外观", "Appearance")}>
              <ThemeSwitch compact className="w-24" />
            </Row>
            <Row label={t("字体", "Font")}>
              <FontSelect />
            </Row>
            {ENGLISH && (
              <Row label={t("语言", "Language")}>
                <LanguageSwitch compact className="w-[124px]" />
              </Row>
            )}
          </div>
        </Presence>
      </div>
    </>
  );
}
