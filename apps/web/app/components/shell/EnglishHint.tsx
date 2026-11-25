// The way to the English edition for a reader whose browser asks for no Chinese, on a Chinese page that has one: a
// small bar at the foot, never a redirect (the address decides the language, lib/i18n.ts). It renders only after
// hydration, so the shared page copy never carries it. Closing it, or choosing 中文 in the language switch, is
// remembered in this browser.
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { ENGLISH } from "@aihot/contracts/english";
import { IconArrowRight, IconClose } from "../icons";
import { Presence } from "../ui/Presence";
import { KEYS, readRaw, writeRaw } from "../../lib/local-state";
import { counterpart, useLocale } from "../../lib/i18n";

/** Whether any of the browser's languages is Chinese, in any script or region. */
const readsChinese = () => (navigator.languages?.length ? navigator.languages : [navigator.language]).some((l) => /^zh(?:-|$)/i.test(l));

const DISMISSED = "aihot:english-hint-dismissed";

/** This browser has said no to the hint (it closes at once if it is showing). */
export function dismissEnglishHint() {
  writeRaw(KEYS.englishHint, "1");
  window.dispatchEvent(new Event(DISMISSED));
}

export function EnglishHint() {
  const locale = useLocale();
  const { pathname, search, hash } = useLocation();
  const english = ENGLISH && locale === "zh" ? counterpart(pathname, "en") : null;
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(!!english && !readsChinese() && readRaw(KEYS.englishHint) !== "1"), [english]);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener(DISMISSED, close);
    return () => window.removeEventListener(DISMISSED, close);
  }, []);
  if (!english) return null;
  const close = () => {
    dismissEnglishHint();
    setOpen(false);
  };
  return (
    // Above the phone's tab bar; at the foot of the window on a desktop. Only the bar itself takes clicks.
    <div lang="en" className="pointer-events-none fixed inset-x-0 bottom-[calc(62px+env(safe-area-inset-bottom))] z-30 flex justify-center px-4 lg:bottom-[max(24px,env(safe-area-inset-bottom))]">
      <Presence show={open} motion="float">
      <div role="region" aria-label="English edition" className="pointer-events-auto flex h-11 items-center rounded-full border border-line bg-raised pl-4 pr-1 text-ui-label text-ink-2 shadow-[var(--shadow-pop)]">
        <span>Prefer English?</span>
        <a href={`${english}${search}${hash}`} hrefLang="en" className="relative ml-1 flex h-9 items-center gap-1 rounded-full px-2.5 font-semibold text-accent-ink transition-colors before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] hover:bg-bg-sunk dark:text-accent">
          Read in English
          <IconArrowRight size={14} />
        </a>
        <button type="button" aria-label="Dismiss" onClick={close} className="relative ml-1 flex size-9 items-center justify-center rounded-full text-ink-3 transition-colors before:absolute before:-inset-1 before:content-[''] hover:bg-bg-sunk hover:text-ink">
          <IconClose size={14} />
        </button>
      </div>
      </Presence>
    </div>
  );
}
