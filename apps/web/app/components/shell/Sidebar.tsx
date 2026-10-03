import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { SITE } from "@aihot/site";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import { useChangelogSeen } from "../../lib/local-state";
import { sidebar, sidebarIsActive, type NavItem } from "./nav";
import { ThemeSwitch } from "./ThemeSwitch";
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
    <Link
      to={item.to}
      prefetch="intent"
      aria-current={isActive ? "page" : undefined}
      className={`flex h-10 items-center gap-2.5 rounded-control px-2.5 text-[14px] transition-colors duration-150 ${
        isActive ? "bg-accent/10 font-semibold text-ink dark:bg-accent-soft" : "font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
      }`}
    >
      <span className={`flex w-[22px] shrink-0 justify-center ${isActive ? "text-accent" : ""}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0 truncate">{item.label}</span>
      {dot && item.changelog && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-hot" aria-label="有新的更新" />}
    </Link>
  );
}

export function Sidebar({ changelogVersion }: { changelogVersion: string | null }) {
  const dot = useChangelogDot(changelogVersion);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[180px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pb-3.5 pt-6 lg:flex">
      <Link to="/" className="mb-4 flex h-[50px] items-center px-1 text-ink" aria-label={`${SITE.name} 首页`}>
        <Wordmark size={26} />
      </Link>
      <nav className="-mx-1 flex-1 overflow-y-auto px-1" aria-label="主导航">
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
            className="mx-1 flex h-[34px] items-center justify-center gap-1.5 rounded-full border border-line text-[12.5px] text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink"
          >
            <IconGithub size={14} />
            GitHub 开源
          </a>
        )}
        <ThemeSwitch className="mx-1" />
        {SITE.icp && (
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="block px-2 text-[10px] text-ink-4 hover:text-ink-3">
            {SITE.icp}
          </a>
        )}
      </div>
    </aside>
  );
}
