// Moving between reports: the archive column on wide desktops; on phones the kind switch in the bar
// (ReportLayout) and recent-issue chips under it, which narrower desktops show above the paper.
import { IntentLink } from "../../components/ui/IntentLink";
import { useEffect, useRef, useState } from "react";
import { REPORT_NAMES, type ReportNavigationEntry, type ReportNavigationResponse, type ReportKind } from "@aihot/contracts/reports";
import { PillTabs } from "../../components/ui/Tabs";
import { IconChevronRight } from "../../components/icons";
import { KINDS, KIND_PATH, archiveMark, kindName, recentIssues, reportPath, type ArchiveGroup } from "./format";
import { apiIn, localizePath, useLocale, useT } from "../../lib/i18n";
import { jumpTo } from "../../lib/motion";
import { foldTo } from "../../lib/disclosure";

/**
 * 日报 / 周报 / 月报 as the site's pill switch: spread across the archive column, or compact in the phone bar
 * (opening at the top). Every place keeps its own layoutId: all of them stay mounted, hidden by width.
 */
export function KindSwitch({ kind, phone = false, layoutId = phone ? "report-kind-phone" : "report-kind" }: { kind: ReportKind; phone?: boolean; layoutId?: string }) {
  const locale = useLocale();
  const t = useT();
  return (
    <PillTabs
      fill={!phone}
      size={phone ? "sm" : "md"}
      layoutId={layoutId}
      label={t("切换日报、周报、月报", "Switch between daily, weekly and monthly")}
      active={kind}
      // Another kind is another paper: it opens at its top, also from the wide archive column that stays in view.
      items={KINDS.map((k) => ({ key: k, label: kindName(k, locale), to: KIND_PATH[k], resetScroll: true, prefetchOnPress: true }))}
    />
  );
}

/** Wide desktop archive column: every issue of this kind, grouped, the current one highlighted. */
export function ReportArchive({ kind, groups, current }: { kind: ReportKind; groups: ArchiveGroup[]; current: string | null }) {
  const locale = useLocale();
  const t = useT();
  const openId = groups.find((g) => g.entries.some((e) => e.key === current))?.id ?? groups[0]?.id;
  return (
    <aside className="sticky top-0 hidden h-dvh w-[280px] shrink-0 flex-col border-r border-line bg-[color-mix(in_srgb,var(--sidebar)_50%,var(--surface))] pl-5 pr-3 side:flex dark:bg-[color-mix(in_srgb,var(--sidebar)_50%,var(--bg))]">
      <div className="pb-4 pt-8">
        <KindSwitch kind={kind} />
      </div>
      <div className={`border-b border-line-strong pb-2 pl-1 text-ui-caption-md font-semibold ${t("tracking-[0.3em]", "uppercase tracking-[0.08em]")} text-ink`}>{t("往期", "Past issues")}</div>
      <nav aria-label={t(`${REPORT_NAMES[kind]}历史`, `Past ${kindName(kind, locale).toLowerCase()} issues`)} className="scrollbar-thin -mr-3 flex-1 overflow-y-auto pb-6 pr-3">
        {groups.map((g) => (
          <ArchiveSection key={g.id} g={g} kind={kind} current={current} initiallyOpen={g.id === openId} />
        ))}
      </nav>
      {kind === "daily" && (
        <IntentLink to="/daily/archive" className="flex h-12 shrink-0 items-center justify-between border-t border-line pl-1 pr-1.5 text-ui-caption-lg font-medium text-ink-2 transition-colors hover:text-accent">
          {t("日报合订本 ", "Daily archive ")}<IconChevronRight size={14} />
        </IntentLink>
      )}
    </aside>
  );
}

/** Closed daily months keep only keys; titles load when opened, and the full archive is SSR. */
function ArchiveSection({ g, kind, current, initiallyOpen }: {
  g: ArchiveGroup; kind: ReportKind; current: string | null; initiallyOpen: boolean;
}) {
  const locale = useLocale();
  const t = useT();
  const [open, setOpen] = useState(initiallyOpen);
  const fold = useRef<HTMLDetailsElement>(null);
  // Another issue chosen: its month unfolds and the last one folds, as a press on their titles would.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else foldTo(fold.current, initiallyOpen);
  }, [initiallyOpen]);
  // A month once opened keeps its list, so closing folds the list away instead of emptying the fold first.
  const [shown, setShown] = useState(initiallyOpen);
  useEffect(() => { if (open) setShown(true); }, [open]);
  const [loaded, setLoaded] = useState<ReportNavigationEntry[] | null>(null);
  // Titles that could not be had leave the dates in their place rather than the placeholders; the month asks
  // again the next time it is opened.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || loaded || kind !== "daily" || !g.entries.some((e) => e.title === undefined)) return;
    setFailed(false);
    const controller = new AbortController();
    fetch(apiIn(`/reports/daily/months/${g.id}`, locale), { signal: controller.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data: ReportNavigationResponse | null) => {
        if (controller.signal.aborted) return;
        if (data) setLoaded(data.items);
        else setFailed(true);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [open, kind, g.id, loaded, locale]);
  const entries = loaded ?? g.entries;
  return (
    <details ref={fold} open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="disclosure group/month border-b border-line">
      <summary className="flex h-11 items-center gap-1.5 pl-1 pr-1.5 text-ui-label text-ink transition-colors hover:text-accent">
        <IconChevronRight size={14} className="text-ink-4 turn group-open/month:rotate-90" />
        <span className="flex-1 font-semibold">{g.label}</span>
        <span className="num text-ui-caption-md text-ink-4">{g.entries.length}</span>
      </summary>
      {(kind !== "daily" || open || shown) && <ul className="space-y-0.5 pb-3">
        {entries.map((e) => {
          const on = e.key === current;
          const mark = archiveMark(kind, e.key, locale);
          return (
            <li key={e.key}>
              <IntentLink
                to={reportPath(kind, e.key)}
                aria-current={on ? "page" : undefined}
                title={e.title ?? undefined}

                className={`group flex gap-3 rounded-tile py-2.5 pl-2.5 pr-2 transition-colors ${on ? "bg-accent-soft" : "hover:bg-bg-sunk"}`}
              >
                <span className="flex w-8 shrink-0 flex-col items-center">
                  <span className={`num text-ui-heading-md font-black leading-none tracking-[-0.03em] ${on ? "text-accent" : "text-ink"}`}>{mark.big}</span>
                  {mark.small && <span className="mt-1 whitespace-nowrap text-ui-micro-7 leading-none text-ink-4">{mark.small}</span>}
                </span>
                {e.title === undefined && kind === "daily" && !loaded && !failed ? (
                  // Its title is on its way: two lines held for it, so the rows do not grow when it lands.
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5" aria-label={`${kindName(kind, locale)} ${e.key}`}>
                    <span className="skeleton h-3 w-full" />
                    <span className="skeleton h-3 w-2/3" />
                  </span>
                ) : (
                  <span className={`line-clamp-2 min-w-0 text-ui-caption-lg leading-[18px] transition-colors ${loaded ? "anim-fade-in" : ""} ${on ? "font-semibold text-ink" : "text-ink-2 group-hover:text-ink"}`}>{e.title ?? `${kindName(kind, locale)} ${e.key}`}</span>
                )}
              </IntentLink>
            </li>
          );
        })}
      </ul>}
      {kind === "daily" && !open && <noscript><a href={localizePath("/daily/archive", locale)}>{t("查看完整日报归档", "See the full daily archive")}</a></noscript>}
    </details>
  );
}

/** Phones under the bar, narrow desktops above the paper: the three latest issues and a way further back. */
export function ReportPhoneNav({ kind, groups, current, today }: { kind: ReportKind; groups: ArchiveGroup[]; current: string | null; today: string }) {
  const locale = useLocale();
  const t = useT();
  const recent = recentIssues(kind, groups, today, locale);
  const earlier = kind === "daily" ? "/daily/archive" : "#report-history";
  const chip = "inline-flex h-11 shrink-0 items-center rounded-full border px-4 text-ui-label transition-colors";
  if (recent.length === 0) return null;
  return (
    <nav aria-label={t(`最近的${REPORT_NAMES[kind]}`, "Recent issues")} className="scrollbar-none bleed flex gap-2 overflow-x-auto pb-1 pt-1.5 lg:mx-0 lg:w-full lg:max-w-[1160px] lg:px-0 lg:pb-4 lg:pt-3 side:hidden">
      {recent.map((e) => {
        const on = e.key === current;
        return (
          <IntentLink key={e.key} to={reportPath(kind, e.key)} aria-current={on ? "page" : undefined} className={`${chip} ${on ? "border-ink bg-ink font-semibold text-bg" : "border-line-strong bg-surface text-ink-2 active:bg-bg-sunk"}`}>
            {e.label}
          </IntentLink>
        );
      })}
      {groups.reduce((sum, g) => sum + g.entries.length, 0) > 3 && (
        <IntentLink to={earlier} viewTransition={kind === "daily"} onClick={earlier.startsWith("#") ? (e) => jumpTo(e, earlier.slice(1)) : undefined} className={`${chip} border-line-strong bg-surface text-ink-2 active:bg-bg-sunk`}>
          {t("更早", "Earlier")}
        </IntentLink>
      )}
    </nav>
  );
}
