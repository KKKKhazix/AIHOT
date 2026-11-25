// Phone search: opens over the page from the bars' magnifier with the keyboard
// already up — the field is focused inside the same tap, which iOS requires — and searches 全部动态
// (/all?q=…). Below the field: this browser's recent searches, topics to browse and what is hot now.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Form, useLocation, useNavigation } from "react-router";
import type { SearchSuggestions } from "@aihot/contracts/site";
import { IconClose, IconSearch } from "../../components/icons";
import { topicsInNav } from "../../components/shell/nav";
import { addRecentSearch, clearRecentSearches, useRecentSearches } from "../../lib/local-state";
import { useModal } from "../../components/ui/modal";
import { Collapse, Presence } from "../../components/ui/Presence";
import { Link } from "../../lib/link";
import { apiIn, localizePath, pagePath, useLocale, useT, type Locale } from "../../lib/i18n";
import { filterKeep, listPath, readFilters } from "../../lib/seo";
import { topicName } from "@aihot/contracts/taxonomy";

// One overlay for the whole site, opened from any bar.
let overlay: HTMLDivElement | null = null;
let field: HTMLInputElement | null = null;
const opener: { current: HTMLElement | null } = { current: null };
let open = false;
let openedAt = "default";
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function setOpen(next: boolean) {
  open = next;
  for (const l of listeners) l();
}

/** Opens the search over the page; call it from the tap itself so the keyboard comes up. */
export function openSearch(query = "", trigger?: HTMLElement) {
  if (!open) opener.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  openedAt = (window.history.state as { key?: string } | null)?.key ?? "default";
  if (overlay && field) {
    overlay.inert = false; // closed, it is inert, and nothing inside an inert overlay takes focus
    field.value = query;
    field.focus({ preventScroll: true });
  }
  setOpen(true);
}

const suggestions = new Map<Locale, Promise<SearchSuggestions>>();

/** Share only an ongoing read; the HTTP cache owns freshness and failed reads can be retried. */
function loadSuggestions(locale: Locale) {
  let read = suggestions.get(locale);
  if (!read) {
    read = fetch(apiIn("/search/suggestions", locale))
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<SearchSuggestions>; })
      .finally(() => { suggestions.delete(locale); });
    suggestions.set(locale, read);
  }
  return read;
}

const RANK_COLOR = ["text-rank-1", "text-rank-2", "text-rank-3"];

export function SearchOverlay() {
  const shown = useSyncExternalStore(subscribe, () => open, () => false);
  const t = useT();
  const locale = useLocale();
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The field is uncontrolled: openSearch() fills and focuses it inside the tap, before React renders.
  const [hasText, setHasText] = useState(false);
  const recent = useRecentSearches();
  const navigation = useNavigation();
  const { key, pathname, search } = useLocation();
  // Searching from 精选 or 全部动态 keeps that list's filter, and from a search its chosen order, as the desktop
  // field does (filterKeep).
  const here = new URLSearchParams(search);
  const list = pagePath(pathname);
  const keep: Record<string, string | null> = list === "/" || list === "/all"
    ? { ...filterKeep(readFilters(here)), tab: list === "/all" && here.get("q") && here.get("tab") === "relevance" ? "relevance" : null }
    : {};
  const [more, setMore] = useState<Awaited<ReturnType<typeof loadSuggestions>> | null>(null);
  // Once opened, the lists stay in the overlay, so closing fades them out with it rather than clearing them first.
  const [opened, setOpened] = useState(false);

  useModal({ open: shown, panel, initialFocus: input, returnFocus: opener, onClose: close });

  useEffect(() => {
    overlay = panel.current;
    field = input.current;
    return () => {
      overlay = null;
      field = null;
      setOpen(false);
    };
  }, []);

  useEffect(() => {
    if (!shown) return;
    let active = true;
    setHasText(!!input.current?.value);
    setOpened(true);
    // The last suggestions stay up while fresh ones load, so the sections do not pop in on every opening; a read
    // that fails takes them down rather than leave old ones standing.
    void loadSuggestions(locale).then(value => { if (active) setMore(value); }).catch(() => { if (active) setMore(null); });
    // At the desktop breakpoint this layer is hidden by CSS; it must stop holding the page still too.
    const desktop = window.matchMedia("(min-width: 700px)");
    const onResize = () => { if (desktop.matches) close(); };
    onResize();
    desktop.addEventListener("change", onResize);
    return () => {
      active = false;
      desktop.removeEventListener("change", onResize);
    };
  }, [shown, locale]);

  // Leaving for the results (or anywhere) closes the search.
  useEffect(() => {
    if (navigation.state === "loading" && open) close();
  }, [navigation.state]);
  useEffect(() => {
    if (openedAt !== key && open) close();
  }, [key]);

  function close() {
    input.current?.blur();
    setOpen(false);
  }

  const companies = (more?.topics ?? []).filter((topic) => topic.group === "company").slice(0, 6);
  const chip = "inline-flex h-11 max-w-full items-center rounded-full px-3.5 text-ui-body-sm transition-colors";
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={t("搜索", "Search")}
      tabIndex={-1}
      inert={!shown}
      className={`fixed inset-0 z-[75] flex flex-col bg-bg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] transition-[opacity,translate] lg:hidden ${shown ? "translate-y-0 opacity-100 duration-(--dur-move)" : "pointer-events-none -translate-y-1 opacity-0 duration-(--dur-leave)"}`}
    >
      <Form
        method="get"
        action={localizePath("/all", locale)}
        role="search"
        onSubmit={(e) => {
          const q = input.current?.value.trim() ?? "";
          if (!q) {
            e.preventDefault();
            return;
          }
          addRecentSearch(q);
        }}
        className="flex h-14 shrink-0 items-center gap-1 pl-4 pr-1 pt-[env(safe-area-inset-top)]"
      >
        {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <label className="relative flex-1">
          <span className="sr-only">{t("搜索标题和摘要", "Search titles and summaries")}</span>
          <IconSearch size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            ref={input}
            name="q"
            type="search"
            onInput={(e) => setHasText(!!e.currentTarget.value)}
            tabIndex={shown ? 0 : -1}
            placeholder={t("搜索标题、摘要…", "Search titles, summaries…")}
            maxLength={200}
            autoComplete="off"
            enterKeyHint="search"
            className="h-10 w-full rounded-full bg-surface pl-10 pr-9 text-ui-body-lg text-ink outline-none ring-1 ring-inset ring-line-strong transition-shadow placeholder:text-ink-4 focus:ring-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] [&::-webkit-search-cancel-button]:hidden"
          />
          <Presence show={hasText} motion="fade">
            <button
              type="button"
              aria-label={t("清空", "Clear")}
              tabIndex={shown ? 0 : -1}
              onClick={() => {
                if (input.current) input.current.value = "";
                setHasText(false);
                input.current?.focus();
              }}
              className="absolute right-1 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full text-ink-4"
            >
              <IconClose size={15} />
            </button>
          </Presence>
        </label>
        <button type="button" tabIndex={shown ? 0 : -1} onClick={close} className="press h-11 shrink-0 px-3 text-ui-body-lg text-accent active:opacity-60">
          {t("取消", "Cancel")}
        </button>
      </Form>

      {opened && (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(24px,env(safe-area-inset-bottom))]">
          {/* Cleared, the searches fold away and what is below rises to meet the field. */}
          <Collapse open={recent.length > 0}>
            <section className="pt-3">
              <div className="flex items-center justify-between">
                <h2 className="text-ui-label font-semibold text-ink-3">{t("最近搜索", "Recent searches")}</h2>
                <button type="button" onClick={clearRecentSearches} className="press -mr-2 h-11 px-2 text-ui-label text-ink-4 active:text-ink-2">
                  {t("清除", "Clear")}
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {recent.map((q) => (
                  <Link key={q} to={listPath("/all", { q, ...keep })} onClick={() => addRecentSearch(q)} className={`${chip} bg-surface text-ink-2 ring-1 ring-inset ring-line active:bg-bg-sunk`}>
                    <span className="truncate">{q}</span>
                  </Link>
                ))}
              </div>
            </section>
          </Collapse>

          {companies.length > 0 && (
            <section className="anim-fade-in pt-6">
              <h2 className="text-ui-label font-semibold text-ink-3">{t("按主题找", "Browse by topic")}</h2>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {companies.map((topic) => (
                  <Link viewTransition key={topic.slug} to={`/topics/${topic.slug}`} className={`${chip} bg-well text-ink-2 ring-1 ring-inset ring-line-soft active:bg-bg-muted`}>
                    <span className="truncate">{topicName(topic.slug, topic.name, locale)}</span>
                  </Link>
                ))}
                {topicsInNav && (
                  <Link viewTransition to="/topics" className={`${chip} gap-0.5 font-medium text-accent`}>
                    {t(`全部 ${more!.topics.length} 个主题`, `All ${more!.topics.length} topics`)}
                  </Link>
                )}
              </div>
            </section>
          )}

          {(more?.hot.length ?? 0) > 0 && (
            <section className="anim-fade-in pt-6">
              <h2 className="text-ui-label font-semibold text-ink-3">{t("当前热点", "Trending now")}</h2>
              <ol className="mt-1 divide-y divide-line-soft">
                {more!.hot.map((h, i) => (
                  <li key={h.to}>
                    <Link viewTransition to={h.to} className="grid h-12 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-3 active:opacity-60">
                      <span className={`num text-center text-ui-body font-black ${RANK_COLOR[i] ?? "text-rank-rest"}`}>{h.rank}</span>
                      <span className="truncate text-ui-body text-ink">{h.title}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
