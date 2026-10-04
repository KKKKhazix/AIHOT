// Phone search: opens over the page from the bars' magnifier with the keyboard
// already up — the field is focused inside the same tap, which iOS requires — and searches 全部动态
// (/all?q=…). Below the field: this browser's recent searches, topics to browse and what is hot now.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Form, Link, useLocation, useNavigation } from "react-router";
import type { SearchSuggestions } from "@aihot/contracts/site";
import { IconClose, IconSearch } from "../../components/icons";
import { addRecentSearch, clearRecentSearches, useRecentSearches } from "../../lib/local-state";
import { useModal } from "../../components/ui/modal";

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

let suggestions: Promise<SearchSuggestions> | null = null;

/** Share only an ongoing read; the HTTP cache owns freshness and failed reads can be retried. */
function loadSuggestions() {
  suggestions ??= fetch('/api/site/search/suggestions')
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<SearchSuggestions>; })
    .finally(() => { suggestions = null; });
  return suggestions;
}

const RANK_COLOR = ["text-rank-1", "text-rank-2", "text-rank-3"];

export function SearchOverlay() {
  const shown = useSyncExternalStore(subscribe, () => open, () => false);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The field is uncontrolled: openSearch() fills and focuses it inside the tap, before React renders.
  const [hasText, setHasText] = useState(false);
  const recent = useRecentSearches();
  const navigation = useNavigation();
  const { key } = useLocation();
  const [more, setMore] = useState<Awaited<ReturnType<typeof loadSuggestions>> | null>(null);

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
    setMore(null);
    void loadSuggestions().then(value => { if (active) setMore(value); }).catch(() => {});
    // At the desktop breakpoint this layer is hidden by CSS; it must stop holding the page still too.
    const desktop = window.matchMedia("(min-width: 961px)");
    const onResize = () => { if (desktop.matches) close(); };
    onResize();
    desktop.addEventListener("change", onResize);
    return () => {
      active = false;
      desktop.removeEventListener("change", onResize);
    };
  }, [shown]);

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

  const companies = (more?.topics ?? []).filter((t) => t.group === "company").slice(0, 6);
  const chip = "inline-flex h-11 max-w-full items-center rounded-full px-3.5 text-[14px] transition-colors";
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label="搜索"
      tabIndex={-1}
      inert={!shown}
      className={`fixed inset-0 z-[75] flex flex-col bg-bg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] transition-[opacity,transform] duration-200 ease-[var(--ease-out-quart)] lg:hidden ${shown ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"}`}
    >
      <Form
        method="get"
        action="/all"
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
        <label className="relative flex-1">
          <span className="sr-only">搜索标题、摘要和正文</span>
          <IconSearch size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            ref={input}
            name="q"
            type="search"
            onInput={(e) => setHasText(!!e.currentTarget.value)}
            tabIndex={shown ? 0 : -1}
            placeholder="搜索标题、摘要和正文"
            maxLength={200}
            autoComplete="off"
            enterKeyHint="search"
            className="h-10 w-full rounded-full bg-surface pl-10 pr-9 text-[16px] text-ink outline-none ring-1 ring-inset ring-line-strong transition-shadow placeholder:text-ink-4 focus:ring-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] [&::-webkit-search-cancel-button]:hidden"
          />
          {hasText && (
            <button
              type="button"
              aria-label="清空"
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
          )}
        </label>
        <button type="button" tabIndex={shown ? 0 : -1} onClick={close} className="h-11 shrink-0 px-3 text-[16px] text-accent">
          取消
        </button>
      </Form>

      {shown && (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(24px,env(safe-area-inset-bottom))]">
          {recent.length > 0 && (
            <section className="pt-3">
              <div className="flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-ink-3">最近搜索</h2>
                <button type="button" onClick={clearRecentSearches} className="-mr-2 h-11 px-2 text-[13px] text-ink-4">
                  清除
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {recent.map((q) => (
                  <Link key={q} to={`/all?q=${encodeURIComponent(q)}`} onClick={() => addRecentSearch(q)} className={`${chip} bg-surface text-ink-2 ring-1 ring-inset ring-line active:bg-bg-sunk`}>
                    <span className="truncate">{q}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {companies.length > 0 && (
            <section className="pt-6">
              <h2 className="text-[13px] font-semibold text-ink-3">按主题找</h2>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {companies.map((t) => (
                  <Link viewTransition key={t.slug} to={`/topics/${t.slug}`} className={`${chip} bg-bg-sunk text-ink-2 ring-1 ring-inset ring-line-soft active:bg-bg-muted dark:bg-bg-muted/60`}>
                    <span className="truncate">{t.name}</span>
                  </Link>
                ))}
                <Link viewTransition to="/topics" className={`${chip} gap-0.5 font-medium text-accent`}>
                  全部 {more!.topics.length} 个主题
                </Link>
              </div>
            </section>
          )}

          {(more?.hot.length ?? 0) > 0 && (
            <section className="pt-6">
              <h2 className="text-[13px] font-semibold text-ink-3">正在热议</h2>
              <ol className="mt-1 divide-y divide-line-soft">
                {more!.hot.map((h, i) => (
                  <li key={h.to}>
                    <Link viewTransition to={h.to} className="grid h-12 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-3 active:opacity-60">
                      <span className={`num text-center text-[15px] font-black ${RANK_COLOR[i] ?? "text-rank-rest"}`}>{h.rank}</span>
                      <span className="truncate text-[15px] text-ink">{h.title}</span>
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
