import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { IntentLink } from "../ui/IntentLink";
import { SITE } from "@aihot/site";
import { RingMark, Wordmark } from "@aihot/site/brand/Logo.tsx";
import { useChangelogSeen } from "../../lib/local-state";
import { rail, railIsActive, sidebar, sidebarIsActive, type NavItem } from "./nav";
import { useScreen } from "./screens";
import { ThemeSwitch } from "./ThemeSwitch";
import { Filings } from "./Filings";
import { IconGithub } from "../icons";

/** True while the changelog has an entry newer than the one this reader last opened. */
export function useChangelogDot(latestVersion: string | null): boolean {
  const seen = useChangelogSeen();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !latestVersion) return false;
  return !seen || seen < latestVersion;
}

function SideLink({ item, dot }: { item: NavItem; dot: boolean }) {
  const { pathname } = useLocation();
  const isActive = sidebarIsActive(item, pathname);
  const Icon = item.icon;
  return (
    <IntentLink
      to={item.to}
      aria-current={isActive ? "page" : undefined}
      className={`flex h-10 items-center gap-2.5 rounded-control px-2.5 text-[14px] transition-colors duration-150 touch:h-11 ${
        isActive ? "bg-accent/10 font-semibold text-ink dark:bg-accent-soft" : "font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
      }`}
    >
      <span className={`flex w-[22px] shrink-0 justify-center ${isActive ? "text-accent" : ""}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0 truncate">{item.label}</span>
      {dot && item.changelog && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-hot" aria-label="有新的更新" />}
    </IntentLink>
  );
}

/**
 * Narrow desktops (lg up to wide: an unfolded foldable, a tablet upright, a phone on its side) leave the
 * page too little room beside the full sidebar, so the phone's tabs stand down the left side instead and
 * the rest of the sidebar sits under 我的, as on phones.
 */
function Rail({ dot }: { dot: boolean }) {
  const { pathname } = useLocation();
  const { tab, home } = useScreen();
  return (
    <aside className="scrollbar-thin sticky top-0 hidden h-dvh w-16 shrink-0 flex-col items-center border-r border-line bg-sidebar px-1.5 pb-[max(14px,env(safe-area-inset-bottom))] pt-5 lg:flex wide:hidden short:overflow-y-auto short:pt-3">
      <Link to="/" className="mb-3 flex size-11 shrink-0 items-center justify-center text-accent short:mb-1" aria-label={`${SITE.name} 首页`}>
        <RingMark className="size-7" />
      </Link>
      <nav className="flex w-full flex-col gap-1" aria-label="主导航">
        {rail().map((t) => {
          const on = railIsActive(t, pathname, tab ?? home);
          const Icon = t.icon;
          return (
            <IntentLink
              key={t.key}
              to={t.to}
              aria-current={on ? "page" : undefined}
              className={`relative flex h-14 shrink-0 flex-col items-center justify-center gap-[3px] rounded-control text-[11px] transition-colors duration-150 short:h-12 ${
                on ? "bg-accent/10 font-semibold text-ink dark:bg-accent-soft" : "font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
              }`}
            >
              <span className={on ? "text-accent" : ""}>
                <Icon size={20} />
              </span>
              <span className="max-w-full truncate">{t.label}</span>
              {dot && t.changelog && <span className="absolute right-2 top-2 size-1.5 rounded-full bg-hot" aria-label="有新的更新" />}
            </IntentLink>
          );
        })}
      </nav>
    </aside>
  );
}

export function Sidebar({ changelogVersion }: { changelogVersion: string | null }) {
  const dot = useChangelogDot(changelogVersion);
  // The links scroll between the wordmark and the footer; in a short window the footer would leave them
  // only a few rows, so the whole column scrolls instead.
  return (
    <>
      <Rail dot={dot} />
      <aside className="scrollbar-thin sticky top-0 hidden h-dvh w-[180px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pb-[max(14px,env(safe-area-inset-bottom))] pt-6 wide:flex short:overflow-y-auto">
        <Link to="/" className="mb-4 flex h-[50px] shrink-0 items-center px-1 text-ink" aria-label={`${SITE.name} 首页`}>
          <Wordmark size={26} />
        </Link>
        <nav className="scrollbar-thin -mx-1 flex-1 overflow-y-auto px-1 short:flex-none short:overflow-visible" aria-label="主导航">
          {sidebar().map((section) => (
            <div key={section.title}>
              <div className="px-2.5 pb-1 pt-3.5 text-[11px] text-ink-4">{section.title}</div>
              <div className="flex flex-col gap-1">
                {section.items.map((item) => (
                  <SideLink key={item.to} item={item} dot={dot} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-2 space-y-2.5 px-1 pt-1">
          {SITE.github && (
            <a
              href={SITE.github}
              target="_blank"
              rel="noopener noreferrer"
              className="mx-1 flex h-[34px] items-center justify-center gap-1.5 rounded-full border border-line text-[12.5px] text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink touch:h-11"
            >
              <IconGithub size={14} />
              GitHub 开源
            </a>
          )}
          <ThemeSwitch className="mx-1 touch:h-11" />
          {/* Centred under the buttons; the full width keeps the longer public-security number on one line. */}
          <div className="-mx-1 flex flex-col items-center gap-1.5">
            <Filings className="whitespace-nowrap text-[9.5px] leading-[1.3] text-ink-4 hover:text-ink-3" badgeSize={10} />
          </div>
        </div>
      </aside>
    </>
  );
}
