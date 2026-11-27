import { useEffect, useState, type ReactNode } from "react";
import { IconMonitor, IconMoon, IconSun } from "../icons";
import { applyTheme, resolvedTheme, setThemePreference, useThemePreference, type ThemePreference } from "../../lib/local-state";
import { reducedMotion } from "../../lib/motion";
import { isHydrated, useHydrated } from "../../lib/hydration";
import { L, useT, type Phrase } from "../../lib/i18n";

type Choice = "dark" | "system" | "light";

const OPTIONS: Array<{ key: Choice; label: Phrase; icon: ReactNode }> = [
  { key: "dark", label: L("深色", "Dark"), icon: <IconMoon size={14} /> },
  { key: "system", label: L("跟随系统", "System"), icon: <IconMonitor size={14} /> },
  { key: "light", label: L("浅色", "Light"), icon: <IconSun size={14} /> },
];

/** Three-way appearance switch (dark / follow the system / light) with a sliding thumb; `compact` for the 更多 menu. */
export function ThemeSwitch({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const pref = useThemePreference();
  const t = useT();
  // Opened after hydration (the 更多 menu), it is drawn at this browser's choice from its first frame. The thumb
  // glides only once it has taken that choice: arriving there after hydration is not a change.
  const mounted = useHydrated();
  const [glides, setGlides] = useState(isHydrated);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGlides(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const current: Choice = !mounted ? "system" : (pref ?? "system");
  const index = OPTIONS.findIndex((o) => o.key === current);

  const choose = (key: Choice) => {
    const nextPref: ThemePreference = key === "system" ? null : key;
    const apply = () => {
      setThemePreference(nextPref);
      applyTheme(resolvedTheme(nextPref), nextPref === null);
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    // The page cross-fades only when its colours change (system to the theme it already shows does not).
    const changes = resolvedTheme(nextPref) !== doc.documentElement.getAttribute("data-theme");
    if (changes && doc.startViewTransition && !reducedMotion()) {
      delete doc.documentElement.dataset.vt; // a cross-fade, not the last page change's slide (transitions.ts)
      doc.startViewTransition(apply);
    } else apply();
  };

  return (
    <div role="radiogroup" aria-label={t("外观", "Appearance")} className={`relative grid ${compact ? "h-7" : "h-[34px]"} grid-cols-3 rounded-full border border-line bg-bg-sunk p-[3px] ${className}`}>
      <span
        aria-hidden="true"
        className={`absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/3)] rounded-full border border-line bg-surface shadow-[var(--shadow-card)] ${glides ? "transition-transform duration-(--dur-move)" : ""}`}
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={current === o.key}
          title={t(o.label)}
          onClick={() => choose(o.key)}
          className={`relative z-10 flex items-center justify-center rounded-full transition-colors touch:before:absolute touch:before:inset-x-0 touch:before:top-1/2 touch:before:h-11 touch:before:-translate-y-1/2 touch:before:content-[''] ${current === o.key ? "text-ink" : "text-ink-4 hover:text-ink-2"}`}
        >
          {o.icon}
          <span className="sr-only">{t(o.label)}</span>
        </button>
      ))}
    </div>
  );
}
