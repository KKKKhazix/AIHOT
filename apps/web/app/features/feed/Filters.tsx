// Feed filters: the channel and category choice (a row of tabs on desktop, a sheet behind the bar's filter
// button on phones), the phone bar of 精选 and 全部, and search.
import { useEffect, useRef, useState } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import { CATEGORY_KEYS, CATEGORY_LABELS, CHANNEL_LABELS, type CategoryKey, type ChannelKey } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/site";
import { IconCheck, IconClose, IconFilter, IconSearch } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";
import { Sheet } from "../../components/ui/Sheet";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import { BarButton, PhoneBar } from "../../components/shell/PhoneBar";
import { openSearch } from "../search/SearchOverlay";

/** Same page with some query parameters changed (paging state dropped). */
function hrefWith(base: string, params: URLSearchParams, patch: Record<string, string | null>) {
  const sp = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  sp.delete("page");
  sp.delete("cursor");
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * The feed's one filter (精选 and 全部动态 alike): none, 一手, or a category. One choice at a time: picking
 * 一手 clears the category and picking a category clears 一手. Older 资讯 / X links still filter; the
 * choice then shows as none.
 */
function filterOptions(base: string, params: URLSearchParams, noneLabel: string) {
  return [
    { key: "all", label: noneLabel, to: hrefWith(base, params, { category: null, channel: null }) },
    { key: "firstParty", label: CHANNEL_LABELS.firstParty, to: hrefWith(base, params, { category: null, channel: "firstParty" }) },
    ...CATEGORY_KEYS.map((k) => ({ key: k, label: CATEGORY_LABELS[k], to: hrefWith(base, params, { category: k, channel: null }) })),
  ];
}

function filterKey(category: CategoryKey | null, channel: ChannelKey): string {
  return channel === "firstParty" ? "firstParty" : (category ?? "all");
}

/** Desktop: the filter as a row of tabs beside the search field. */
export function CategoryTabs({ base, category, channel = "all", layoutId, className = "" }: { base: string; category: CategoryKey | null; channel?: ChannelKey; layoutId: string; className?: string }) {
  const [params] = useSearchParams();
  return <PillTabs items={filterOptions(base, params, "全部").map(o => ({ ...o, prefetch: 'intent' as const }))} active={filterKey(category, channel)} layoutId={layoutId} label="筛选" className={className} />;
}

/**
 * The phone bar of 精选 and 全部: the brand, the 精选 | 全部 switch (a filter in use carries over), and
 * buttons for the filter sheet and search.
 */
export function FeedBar({ base, category, channel }: { base: "/" | "/all"; category: CategoryKey | null; channel: ChannelKey }) {
  const [params] = useSearchParams();
  const [sheet, setSheet] = useState(false);
  const scope = (to: string) => hrefWith(to, params, { q: null, tab: null, search: null });
  const filtered = filterKey(category, channel) !== "all";
  return (
    <>
      <PhoneBar
        leading={
          <Link to="/" aria-label={`${SITE.name} 首页`} className="flex h-11 items-center pl-2.5 pr-2 text-ink">
            <Wordmark size={17} />
          </Link>
        }
        center={
          <PillTabs
            size="sm"
            layoutId="feed-scope"
            label="看精选或全部"
            active={base === "/" ? "featured" : "all"}
            items={[
              { key: "featured", label: "精选", to: scope("/"), resetScroll: true, prefetch: 'intent' },
              { key: "all", label: "全部", to: scope("/all"), resetScroll: true, prefetch: 'intent' },
            ]}
          />
        }
        actions={
          <>
            <BarButton label={filtered ? "筛选（已选）" : "筛选"} on={filtered} onClick={() => setSheet(true)}>
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
  return (
    <Sheet open={open} onClose={onClose} title="筛选">
      <ul className="mx-4 divide-y divide-line-soft">
        {filterOptions(base, params, "不限").map((o) => {
          const on = o.key === active;
          return (
            <li key={o.key}>
              <Link
                to={o.to}
                onClick={onClose}
                aria-current={on ? "true" : undefined}
                className={`-mx-2 flex h-12 items-center justify-between rounded-tile px-2 text-[16px] transition-colors active:bg-bg-sunk ${on ? "font-semibold text-accent" : "text-ink"}`}
              >
                {o.label}
                {on && <IconCheck size={19} strokeWidth={2.2} />}
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
  const label = channel === "firstParty" ? CHANNEL_LABELS.firstParty : category ? CATEGORY_LABELS[category] : null;
  if (!label && !tag) return null;
  const chip = "inline-flex min-h-11 max-w-full items-center gap-1 rounded-full bg-accent-soft pl-3 pr-2 text-[13px] font-medium text-accent transition-opacity active:opacity-60";
  return (
    <div className="flex flex-wrap gap-2 pb-3 pt-1 lg:hidden">
      {label && (
        <Link to={hrefWith(base, params, { category: null, channel: null })} aria-label={`取消筛选：${label}`} className={chip}>
          只看{label}
          <IconClose size={14} strokeWidth={2} />
        </Link>
      )}
      {tag && (
        <Link to={hrefWith(base, params, { tag: null })} aria-label={`取消标签：${tag}`} className={chip}>
          <span className="truncate">#{tag}</span>
          <IconClose size={14} strokeWidth={2} className="shrink-0" />
        </Link>
      )}
    </div>
  );
}

/** Phones: the magnifier in a bar; the search opens over the page with the keyboard up. */
function SearchButton() {
  return (
    <BarButton label="搜索" onClick={(event) => openSearch("", event.currentTarget)}>
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
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(defaultValue), [defaultValue]);
  useSlashFocus(inputRef);
  const searching = navigation.state === "loading" && navigation.location?.pathname === "/all" && !!new URLSearchParams(navigation.location.search).get("q");
  const hidden = Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null));

  return (
    <Form method="get" action="/all" role="search" className="group relative w-full shrink-0 lg:w-60">
      {hidden}
      <label htmlFor="site-search" className="sr-only">
        搜索标题、摘要与正文
      </label>
      <IconSearch size={16} className={`pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 transition-colors ${searching ? "text-accent" : "text-ink-4 group-focus-within:text-ink-3"}`} />
      <input
        ref={inputRef}
        id="site-search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="搜索标题、摘要…"
        maxLength={200}
        autoComplete="off"
        className="h-[42px] w-full rounded-full bg-bg-sunk pl-10 pr-10 text-[14px] text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent dark:bg-bg-muted/60 dark:focus:bg-surface"
      />
      {value ? (
        <button
          type="button"
          aria-label="清空"
          onClick={() => {
            setValue("");
            inputRef.current?.focus();
          }}
          className="absolute right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink"
        >
          <IconClose size={13} />
        </button>
      ) : (
        <kbd className="mono pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-mark border border-line-strong bg-surface px-1.5 text-[10.5px] leading-4 text-ink-4 lg:block">/</kbd>
      )}
    </Form>
  );
}
