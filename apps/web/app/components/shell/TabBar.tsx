import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useLocation, useRevalidator } from "react-router";
import { IntentLink } from "../ui/IntentLink";
import { tabs, type TabKey } from "./nav";
import { noteScreen, rememberedTab, useScreen } from "./screens";
import { markBack } from "./transitions";
import { scrollBehavior } from "../../lib/motion";
import { useChangelogDot } from "./Sidebar";
import { pagePath, useLocale, useT } from "../../lib/i18n";

const subscribe = () => () => {};
const serverTab = () => null;
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The phone tab bar (below lg). A page lights the tab it declares; pages reached from several tabs keep
 * the tab the reader came from. Tapping the tab you are on goes back to its first screen (sliding back,
 * as the bar's back button does); on that screen it scrolls to the top, and at the top it reloads the
 * page's data. Articles bring their own toolbar instead.
 */
export function TabBar({ changelogVersion }: { changelogVersion: string | null }) {
  const screen = useScreen();
  const { pathname: address, key } = useLocation();
  // Tabs name the pages' paths; an English page's address carries /en in front.
  const pathname = pagePath(address);
  const revalidator = useRevalidator();
  const dot = useChangelogDot(changelogVersion);
  const last = useRef<TabKey | undefined>(undefined);
  const restored = useSyncExternalStore(subscribe, () => rememberedTab(key), serverTab);
  const locale = useLocale();
  const t = useT();
  const items = tabs(locale);
  const requested = screen.tab ?? restored ?? last.current ?? screen.home;
  const active = requested && !items.some((t) => t.key === requested) ? "featured" : requested;
  useIsoLayoutEffect(() => {
    // Do not overwrite a saved entry with the server fallback before hydration reads this browser's tab.
    if (restored === null) return;
    last.current = active;
    noteScreen(screen.name === undefined ? undefined : t(screen.name), key, active);
  }, [active, key, screen.name, restored, t]);
  if (screen.toolbar) return null;
  return (
    <nav
      aria-label={t("底部导航", "Tabs")}
      className="fixed inset-x-0 bottom-0 z-40 bg-surface/90 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-[0_-1px_0_var(--line)] backdrop-blur-xl backdrop-saturate-150 lg:hidden"
    >
      <div className="mx-auto grid h-[50px] max-w-[640px]" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((tab) => {
          const on = tab.key === active;
          const Icon = tab.icon;
          return (
            <IntentLink
              key={tab.key}
              to={tab.to}
              aria-current={on ? "page" : undefined}
              viewTransition={on && pathname !== tab.to}
              onClick={(event) => {
                if (!on || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                if (pathname !== tab.to) return markBack();
                event.preventDefault();
                if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: scrollBehavior() });
                else if (revalidator.state === "idle") void revalidator.revalidate();
              }}
              className={`relative flex flex-col items-center justify-center gap-[2px] text-ui-micro-8 transition-colors ${on ? "font-semibold text-accent" : "text-ink-3 active:text-ink"}`}
            >
              <Icon size={23} />
              <span>{t(tab.label)}</span>
              {dot && tab.changelog && <span className="absolute left-[calc(50%+9px)] top-[7px] size-1.5 rounded-full bg-hot" aria-label={t("有新的更新", "New updates")} />}
            </IntentLink>
          );
        })}
      </div>
    </nav>
  );
}
