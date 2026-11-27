import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { IntentLink } from "../ui/IntentLink";
import { useContainedScroll } from "../ui/Page";
import { SITE } from "@aihot/site";
import { RingMark, Wordmark } from "@aihot/site/brand/Logo.tsx";
import { useHydrated } from "../../lib/hydration";
import { getReadIds, setChangelogSeen, useChangelogSeen } from "../../lib/local-state";
import { activeSidebarItem, rail, railIsActive, sidebar, type NavItem } from "./nav";
import { useScreen } from "./screens";
import { MoreMenu } from "./MoreMenu";
import { Filings } from "./Filings";
import { IconGithub } from "../icons";
import { Link } from "../../lib/link";
import { pagePath, useLocale, useT } from "../../lib/i18n";

/**
 * True while the changelog has an entry newer than the one this reader last opened. A first visit (nothing read in
 * this browser yet) counts from now: everything is new to a first-time reader, so the dot would only say "unread"
 * about the site itself; it lights for the updates that come after. A returning reader who never opened the
 * changelog still sees it.
 */
export function useChangelogDot(latestVersion: string | null): boolean {
  const seen = useChangelogSeen();
  const mounted = useHydrated();
  useEffect(() => {
    if (mounted && latestVersion && !seen && getReadIds().length === 0) setChangelogSeen(latestVersion);
  }, [mounted, latestVersion, seen]);
  if (!mounted || !latestVersion) return false;
  return seen ? seen < latestVersion : getReadIds().length > 0;
}

function SideLink({ item, dot, active }: { item: NavItem; dot: boolean; active: boolean }) {
  const t = useT();
  const Icon = item.icon;
  return (
    <IntentLink
      to={item.to}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 items-center gap-2.5 rounded-control px-2.5 text-ui-body-sm transition-colors touch:h-11 ${
        active ? "bg-accent/10 font-semibold text-ink dark:bg-accent-soft" : "font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
      }`}
    >
      <span className={`flex w-[22px] shrink-0 justify-center ${active ? "text-accent" : ""}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0 truncate">{t(item.label)}</span>
      {dot && item.changelog && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-hot" aria-label={t("有新的更新", "New updates")} />}
    </IntentLink>
  );
}

/**
 * Narrow desktops (lg up to wide: an unfolded foldable, a tablet upright, a phone on its side) leave the
 * page too little room beside the full sidebar, so the phone's tabs stand down the left side instead and
 * the rest of the sidebar sits under 我的, as on phones.
 */
function Rail({ dot }: { dot: boolean }) {
  const pathname = pagePath(useLocation().pathname);
  const locale = useLocale();
  const t = useT();
  const { tab: screenTab, home } = useScreen();
  const [railRef, railOverscroll] = useContainedScroll<HTMLElement>();
  return (
    <aside ref={railRef} className={`scrollbar-thin sticky top-0 z-30 hidden h-dvh w-16 shrink-0 flex-col items-center border-r border-line bg-sidebar px-1.5 pb-[max(14px,env(safe-area-inset-bottom))] pt-5 lg:flex wide:hidden short:overflow-y-auto short:pt-3 ${railOverscroll}`}>
      <Link to="/" className="mb-3 flex size-11 shrink-0 items-center justify-center text-accent short:mb-1" aria-label={t(`${SITE.name} 首页`, `${SITE.name} home`)}>
        <RingMark className="size-7" />
      </Link>
      <nav className="flex w-full flex-col gap-1" aria-label={t("主导航", "Main")}>
        {rail(locale).map((tab) => {
          const on = railIsActive(tab, pathname, screenTab ?? home);
          const Icon = tab.icon;
          return (
            <IntentLink
              key={tab.key}
              to={tab.to}
              aria-current={on ? "page" : undefined}
              className={`relative flex h-14 shrink-0 flex-col items-center justify-center gap-[3px] rounded-control text-ui-caption-sm transition-colors short:h-12 ${
                on ? "bg-accent/10 font-semibold text-ink dark:bg-accent-soft" : "font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
              }`}
            >
              <span className={on ? "text-accent" : ""}>
                <Icon size={20} />
              </span>
              <span className="max-w-full truncate">{t(tab.label)}</span>
              {dot && tab.changelog && <span className="absolute right-2 top-2 size-1.5 rounded-full bg-hot" aria-label={t("有新的更新", "New updates")} />}
            </IntentLink>
          );
        })}
      </nav>
    </aside>
  );
}

export function Sidebar({ changelogVersion }: { changelogVersion: string | null }) {
  const dot = useChangelogDot(changelogVersion);
  const pathname = pagePath(useLocation().pathname);
  const locale = useLocale();
  const t = useT();
  const [columnRef, columnOverscroll] = useContainedScroll<HTMLElement>();
  const [navRef, navOverscroll] = useContainedScroll<HTMLElement>();
  const footRef = useRef<HTMLDivElement>(null);
  // The links scroll between the wordmark and the footer; in a short window the footer would leave them
  // only a few rows, so the whole column scrolls instead. Sticky makes the column its own layer: z-30 puts it
  // over the page's sticky day bars (z-20), so the 更多 panel it opens covers the timeline, not the other way round.
  return (
    <>
      <Rail dot={dot} />
      <aside ref={columnRef} className={`scrollbar-thin sticky top-0 z-30 hidden h-dvh w-[180px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pb-[max(14px,env(safe-area-inset-bottom))] pt-6 wide:flex short:overflow-y-auto ${columnOverscroll}`}>
        <Link to="/" className="mb-4 flex h-[50px] shrink-0 items-center px-1 text-ink" aria-label={t(`${SITE.name} 首页`, `${SITE.name} home`)}>
          <Wordmark size={26} />
        </Link>
        <nav ref={navRef} className={`scrollbar-thin -mx-1 flex-1 overflow-y-auto px-1 short:flex-none short:overflow-visible ${navOverscroll}`} aria-label={t("主导航", "Main")}>
          {sidebar(locale).map((section) => {
            // Only the most specific entry of a section is lit, so a detail page does not light the list above it too.
            const lit = activeSidebarItem(section.items, pathname);
            return (
              <div key={section.key}>
                {section.title ? (
                  <div className="px-2.5 pb-1 pt-3.5 text-ui-caption-sm text-ink-4">{t(section.title)}</div>
                ) : (
                  <div className="mx-2.5 mb-2 mt-3.5 border-t border-line" />
                )}
                <div className="flex flex-col gap-1">
                  {section.items.map((item) => (
                    <SideLink key={item.to} item={item} dot={dot} active={item.to === lit?.to} />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="mt-2 space-y-2.5 px-1 pt-1">
          {/* GitHub keeps its mark on the left; the account and the settings sit under 更多 beside it. */}
          <div ref={footRef} className="mx-1 flex items-center gap-2">
            {SITE.github && (
              <a
                href={SITE.github}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("GitHub 开源", "Open source on GitHub")}
                title={t("GitHub 开源", "Open source on GitHub")}
                className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-line text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink touch:size-11"
              >
                <IconGithub size={15} />
              </a>
            )}
            <MoreMenu anchor={() => footRef.current} />
          </div>
          {/* Centred under the buttons; the full width keeps the longer public-security number on one line. */}
          <div className="-mx-1 flex flex-col items-center gap-1.5">
            {SITE.poweredBy && (
              <a href={SITE.poweredBy.url} target="_blank" rel="noopener" className="whitespace-nowrap text-ui-micro-6 leading-[1.3] text-ink-4 hover:text-ink-3">
                {t(<>由 {SITE.poweredBy.name} 驱动</>, <>Powered by {SITE.poweredBy.name}</>)}
              </a>
            )}
            <Filings className="whitespace-nowrap text-ui-micro-6 leading-[1.3] text-ink-4 hover:text-ink-3" badgeSize={10} />
          </div>
        </div>
      </aside>
    </>
  );
}
