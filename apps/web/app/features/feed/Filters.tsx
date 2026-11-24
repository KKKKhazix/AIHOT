// Feed filters: the channel and category choice (a row of tabs on desktop, a sheet behind the bar's filter
// button on phones), the phone bar of 精选 and 全部, and search.
import { useEffect, useRef, useState } from "react";
import { Form, useNavigation, useSearchParams } from "react-router";
import { CATEGORY_KEYS, categoryLabel, channelLabel, displayTagIn, type CategoryKey, type ChannelKey } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/site";
import { IconClose, IconFilter, IconSearch } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";
import { ChoiceTick, Sheet, sheetChoice } from "../../components/ui/Sheet";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import { BarButton, PhoneBar } from "../../components/shell/PhoneBar";
import { openSearch } from "../search/SearchOverlay";
import { feedListPath } from "../../lib/seo";
import { Link } from "../../lib/link";
import { localizePath, pagePath, useLocale, useT, type Locale } from "../../lib/i18n";

/**
 * The feed's one filter (精选 and 全部动态 alike): none, 一手, or a category. One choice at a time: picking
 * 一手 clears the category and picking a category clears 一手. Older 资讯 / X links still filter; the
 * choice then shows as none.
 */
function filterOptions(base: string, params: URLSearchParams, noneLabel: string, locale: Locale) {
  const option = (key: string, label: string, patch: Partial<Record<"category" | "channel", string | null>>) => {
    const to = feedListPath(base, params, patch);
    // Filtered feed views are noindex; keep crawler focus on the unfiltered list.
    return { key, label, to, rel: to.includes("?") ? "nofollow" : undefined };
  };
  return [
    option("all", noneLabel, { category: null, channel: null }),
    option("firstParty", channelLabel("firstParty", locale), { category: null, channel: "firstParty" }),
    ...CATEGORY_KEYS.map((k) => option(k, categoryLabel(k, locale), { category: k, channel: null })),
  ];
}

function filterKey(category: CategoryKey | null, channel: ChannelKey): string {
  return channel === "firstParty" ? "firstParty" : (category ?? "all");
}

/** Desktop: the filter as a row of tabs beside the search field. */
export function CategoryTabs({ base, category, channel = "all", layoutId, className = "" }: { base: string; category: CategoryKey | null; channel?: ChannelKey; layoutId: string; className?: string }) {
  const [params] = useSearchParams();
  const t = useT();
  const items = filterOptions(base, params, t("全部", "All"), useLocale()).map((o) => ({ ...o, prefetchOnPress: true }));
  return <PillTabs items={items} active={filterKey(category, channel)} layoutId={layoutId} label={t("筛选", "Filter")} className={className} />;
}

/**
 * The phone bar of 精选 and 全部: the brand, the 精选 | 全部 switch (a filter in use carries over), and
 * buttons for the filter sheet and search.
 */
export function FeedBar({ base, category, channel }: { base: "/" | "/all"; category: CategoryKey | null; channel: ChannelKey }) {
  const [params] = useSearchParams();
  const t = useT();
  const [sheet, setSheet] = useState(false);
  const scope = (to: string) => {
    const href = feedListPath(to, params, { q: null, tab: null });
    return { to: href, rel: href.includes("?") ? "nofollow" : undefined };
  };
  const filtered = filterKey(category, channel) !== "all";
  return (
    <>
      <PhoneBar
        leading={
          <Link to="/" aria-label={t(`${SITE.name} 首页`, `${SITE.name} home`)} className="flex h-11 items-center pl-2.5 pr-2 text-ink">
            <Wordmark size={17} />
          </Link>
        }
        center={
          <PillTabs
            size="sm"
            layoutId="feed-scope"
            label={t("看精选或全部", "Top Picks or All")}
            active={base === "/" ? "featured" : "all"}
            items={[
              { key: "featured", label: t("精选", "Top Picks"), ...scope("/"), resetScroll: true, prefetchOnPress: true },
              { key: "all", label: t("全部", "All"), ...scope("/all"), resetScroll: true, prefetchOnPress: true },
            ]}
          />
        }
        actions={
          <>
            <BarButton label={filtered ? t("筛选（已选）", "Filter (on)") : t("筛选", "Filter")} on={filtered} onClick={() => setSheet(true)}>
              <IconFilter size={21} />
              {filtered && <span aria-hidden="true" className="absolute right-[9px] top-[9px] size-[7px] rounded-full bg-accent ring-2 ring-bg" />}
            </BarButton>
            <SearchButton />
          </>
        }
      />
      <FilterSheet open={sheet} onClose={() => setSheet(false)} base={base} active={filterKey(category, channel)} />
    </>
  );
}

/** Phones: the filter as a sheet of options, the one in use ticked; choosing one applies it. */
function FilterSheet({ open, onClose, base, active }: { open: boolean; onClose: () => void; base: string; active: string }) {
  const [params] = useSearchParams();
  const t = useT();
  const locale = useLocale();
  return (
    <Sheet open={open} onClose={onClose} title={t("筛选", "Filter")}>
      <ul className="mx-4 divide-y divide-line-soft">
        {filterOptions(base, params, t("不限", "Any"), locale).map((o) => {
          const on = o.key === active;
          return (
            <li key={o.key}>
              <Link
                to={o.to}
                rel={o.rel}
                onClick={onClose}
                aria-current={on ? "true" : undefined}
                className={`-mx-2 rounded-tile px-2 ${sheetChoice(on)}`}
              >
                {o.label}
                {on && <ChoiceTick />}
              </Link>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/** Phones: the filter and tag in use as chips under the bar; each one clears itself when tapped. */
export function ActiveFilters({ base, category, channel, tag }: { base: string; category: CategoryKey | null; channel: ChannelKey; tag: string | null }) {
  const [params] = useSearchParams();
  const t = useT();
  const locale = useLocale();
  const label = channel === "firstParty" ? channelLabel("firstParty", locale) : category ? categoryLabel(category, locale) : null;
  const shownTag = tag ? displayTagIn(tag, locale) : null;
  if (!label && !tag) return null;
  const chip = "inline-flex min-h-11 max-w-full items-center gap-1 rounded-full bg-accent-soft pl-3 pr-2 text-ui-label font-medium text-accent transition-opacity active:opacity-60";
  const clearFilter = feedListPath(base, params, { category: null, channel: null });
  const clearTag = feedListPath(base, params, { tag: null });
  return (
    <div className="flex flex-wrap gap-2 pb-3 pt-1 lg:hidden">
      {label && (
        <Link to={clearFilter} rel={clearFilter.includes("?") ? "nofollow" : undefined} aria-label={t(`取消筛选：${label}`, `Clear filter: ${label}`)} className={chip}>
          {t(<>只看{label}</>, <>{label} only</>)}
          <IconClose size={14} strokeWidth={2} />
        </Link>
      )}
      {tag && (
        <Link to={clearTag} rel={clearTag.includes("?") ? "nofollow" : undefined} aria-label={shownTag ? t(`取消标签：${shownTag}`, `Clear tag: ${shownTag}`) : t("取消标签筛选", "Clear tag filter")} className={chip}>
          <span className="truncate">{shownTag ? `#${shownTag}` : t("标签筛选", "Tag filter")}</span>
          <IconClose size={14} strokeWidth={2} className="shrink-0" />
        </Link>
      )}
    </div>
  );
}

/** Phones: the magnifier in a bar; the search opens over the page with the keyboard up. */
function SearchButton() {
  const t = useT();
  return (
    <BarButton label={t("搜索", "Search")} onClick={(event) => openSearch("", event.currentTarget)}>
      <IconSearch size={21} />
    </BarButton>
  );
}

function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}

/** Desktop search field (GET /all?q=…): at the end of the filter row as the same grey track, at the height of md tabs, with a "/" hint. */
export function SearchField({ defaultValue = "", keep = {} }: { defaultValue?: string; keep?: Record<string, string | null> }) {
  const [value, setValue] = useState(defaultValue);
  const navigation = useNavigation();
  const t = useT();
  const locale = useLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(defaultValue), [defaultValue]);
  useSlashFocus(inputRef);
  const searching = navigation.state === "loading" && !!navigation.location && pagePath(navigation.location.pathname) === "/all" && !!new URLSearchParams(navigation.location.search).get("q");
  const hidden = Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null));

  return (
    <Form method="get" action={localizePath("/all", locale)} role="search" className="group relative w-full shrink-0 lg:w-60">
      {hidden}
      <label htmlFor="site-search" className="sr-only">
        {t("搜索标题和摘要", "Search titles and summaries")}
      </label>
      <IconSearch size={16} className={`pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 transition-colors ${searching ? "text-accent" : "text-ink-4 group-focus-within:text-ink-3"}`} />
      <input
        ref={inputRef}
        id="site-search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("搜索标题、摘要…", "Search titles, summaries…")}
        maxLength={200}
        autoComplete="off"
        className="h-[42px] w-full rounded-full bg-well pl-10 pr-10 text-ui-body-lg text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent sm:text-ui-body-sm"
      />
      {value ? (
        <button
          type="button"
          aria-label={t("清空", "Clear")}
          onClick={() => {
            setValue("");
            inputRef.current?.focus();
          }}
          className="absolute right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink"
        >
          <IconClose size={13} />
        </button>
      ) : (
        <kbd className="mono pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-mark border border-line-strong bg-surface px-1.5 text-ui-micro-8 leading-4 text-ink-4 lg:block">/</kbd>
      )}
    </Form>
  );
}
