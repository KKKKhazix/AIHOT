// The day-grouped feed (精选 home, topics): a time rail with cards on desktop, dated rows under grey
// day bars on phones. Keeps its place across back navigation and loads further pages. There is no
// "new items" prompt: readers refresh for the latest head (feedback #1199).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";
import { Collapse } from "../../components/ui/Presence";
import type { TimelineCard, TimelineFilters, TimelineResponse } from "@aihot/contracts/site";
import { FeedItem } from "./FeedItem";
import { IconChevronDown } from "../../components/icons";
import { RingMark } from "../../components/Logo";
import { EmptyState } from "../../components/ui/Page";
import { beijingDate, beijingTime, beijingWeekday } from "../../lib/format";
import { markRead, useReadSet } from "../../lib/local-state";
import { isHydrated, isReload, markHydrated, readSnapshot, restoreAnchor, saveSnapshot } from "./restore";

const AUTO_BATCHES = 3;

interface ListState {
  cards: TimelineCard[];
  nextCursor: string | null;
  dayCounts: Record<string, number>;
  collapsed: string[];
  batches: number;
}

function filterQuery(f: TimelineFilters, extra: Record<string, string | number | null | undefined> = {}) {
  const sp = new URLSearchParams();
  if (f.channel !== "all") sp.set("channel", f.channel);
  if (f.category) sp.set("category", f.category);
  if (f.tag) sp.set("tag", f.tag);
  if (f.topic) sp.set("topic", f.topic);
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  return sp.toString();
}

function fromResponse(r: TimelineResponse): ListState {
  return { cards: r.cards, nextCursor: r.nextCursor, dayCounts: r.dayCounts, collapsed: [], batches: 1 };
}

const WEEKDAY_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** Sticky day header: a quiet row on desktop, a grey full-width bar on phones. */
export function DayHeader({ day, today, count, collapsed, onToggle }: { day: string; today: string; count: number | null; collapsed?: boolean; onToggle?: () => void }) {
  const [, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = `${m}月${d}日`;
  const weekday = beijingWeekday(day);
  const short = WEEKDAY_SHORT[new Date(`${day}T12:00:00+08:00`).getUTCDay()] ?? "";
  return (
    <div className="sticky top-0 z-20 -mx-4 bg-daybar px-4 lg:mx-0 lg:bg-bg lg:px-0">
      {/* Phones: a full-width day bar. */}
      <div className="flex h-9 items-center gap-2 lg:hidden">
        <span className="text-[14px] font-bold text-ink">{day === today ? "今天" : date}</span>
        {day === today && <span className="text-[12.5px] text-ink-4">{date}</span>}
        <span className="text-[12.5px] text-ink-4">{short}</span>
      </div>
      {/* Desktop: the date ends where the times end, the fold toggle sits on the rail. */}
      <div className="hidden h-11 grid-cols-[64px_22px_minmax(0,1fr)] items-center lg:grid">
        <button type="button" onClick={onToggle} disabled={!onToggle} className="justify-self-end whitespace-nowrap text-right text-[18px] font-semibold leading-6 text-ink">
          {date}
        </button>
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `展开${date}` : `收起${date}`}
            className="grid size-6 place-items-center justify-self-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink"
          >
            <IconChevronDown size={14} className={`transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`} />
          </button>
        ) : (
          <span />
        )}
        <span className="text-[13px] text-ink-4">
          {weekday}
          {count !== null && (
            <>
              {" · "}
              <span className="num">{count}</span> 条
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * One dated slot: the time, the rail (desktop) and the item. As on the original timeline, the rail is a
 * 1px line from this node's centre to the next one's, so the day reads as one continuous thread.
 */
export function TimelineSlot({ at, children, fresh = false, delay = 0, dataKey }: { at: string; children: React.ReactNode; fresh?: boolean; delay?: number; dataKey?: string }) {
  return (
    <li
      data-card-key={dataKey}
      className={`group/slot grid grid-cols-[48px_minmax(0,1fr)] border-b border-line-soft py-3.5 last:border-b-0 lg:grid-cols-[64px_22px_minmax(0,1fr)] lg:border-b-0 lg:py-0 lg:pb-3 lg:last:pb-0 ${fresh ? "animate-fade-up" : ""}`}
      style={fresh ? { animationDelay: `${delay}ms` } : undefined}
    >
      <time dateTime={at} className="mono pt-[2px] text-[13px] leading-[18px] text-ink-4 lg:pt-[17px] lg:text-[12.5px] lg:font-semibold lg:leading-6 lg:text-ink-3">
        {beijingTime(at)}
      </time>
      <span aria-hidden="true" className="relative hidden lg:block">
        <span className="absolute -bottom-[41px] left-[10.5px] top-[29px] w-px bg-line-strong group-last/slot:hidden" />
        <span className="absolute left-[7.5px] top-[25.5px] size-[7px] rounded-full bg-accent shadow-[0_0_0_4px_var(--bg)] transition-transform duration-300 group-hover/slot:scale-[1.15]" />
      </span>
      {children}
    </li>
  );
}

export function Timeline({ initial, filters }: { initial: TimelineResponse; filters: TimelineFilters }) {
  const location = useLocation();
  const navigation = useNavigation();
  const readSet = useReadSet();
  const historyKey = location.key;

  // Back navigation (client side): restore synchronously from the snapshot. A full reload restores
  // after hydration so the first client render matches the server HTML.
  const [state, setState] = useState<ListState>(() => {
    if (isHydrated()) {
      const snap = readSnapshot<ListState>(historyKey);
      if (snap && snap.data.cards.length > 0) return snap.data;
    }
    return fromResponse(initial);
  });
  const restoredRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [freshKeys, setFreshKeys] = useState<Set<string>>(() => new Set());
  const stateRef = useRef(state);
  stateRef.current = state;

  // Filters (i.e. the loader data) changed. A page still loading for the old filters is cancelled, and a
  // response that arrives anyway is dropped (it belongs to another list and cursor). Back or forward to a
  // filter already visited restores what that history entry had loaded and folded; a new one starts over.
  const filterKey = filterQuery(filters);
  const lastFilterKey = useRef(filterKey);
  const pageRequest = useRef<AbortController | null>(null);
  useEffect(() => () => pageRequest.current?.abort(), []);
  useLayoutEffect(() => {
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      pageRequest.current?.abort();
      pageRequest.current = null;
      setLoadingMore(false);
      setLoadError(false);
      const snap = readSnapshot<ListState>(historyKey);
      if (snap && snap.data.cards.length > 0) {
        setState(snap.data);
        restoreAnchor(snap.anchor, snap.scrollY);
      } else {
        setState(fromResponse(initial));
      }
    }
  }, [filterKey, initial, historyKey]);

  useLayoutEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const snap = readSnapshot<ListState>(historyKey);
    if (!isHydrated()) {
      markHydrated();
      // A full load keeps the server's fresh list when the reader reloaded; after a back/forward
      // that reloaded the document, it restores the saved list and position.
      if (snap && snap.data.cards.length > 0 && !isReload()) {
        setState(snap.data);
        requestAnimationFrame(() => restoreAnchor(snap.anchor, snap.scrollY));
      }
      return;
    }
    if (snap && snap.data.cards.length > 0) restoreAnchor(snap.anchor, snap.scrollY);
  }, [historyKey]);

  // Save the snapshot whenever we leave this history entry.
  useEffect(() => {
    if (navigation.state === "loading" && navigation.location && navigation.location.key !== historyKey) {
      saveSnapshot(historyKey, stateRef.current);
    }
  }, [navigation.state, navigation.location, historyKey]);
  useEffect(() => {
    const save = () => saveSnapshot(historyKey, stateRef.current);
    const onHide = () => saveSnapshot(historyKey, stateRef.current, "[data-card-key]", true);
    // A prefetched navigation can commit without a loading render. Capture its anchor before the
    // router replaces the list; modifiers/new tabs leave this history entry in place.
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const to = new URL(link.href, window.location.href);
      if (to.origin === window.location.origin && to.pathname + to.search !== window.location.pathname + window.location.search) save();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", save);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", save);
      window.removeEventListener("pagehide", onHide);
    };
  }, [historyKey]);

  const loadMore = useCallback(async () => {
    const s = stateRef.current;
    if (!s.nextCursor || pageRequest.current) return;
    const key = filterQuery(filters);
    const controller = new AbortController();
    pageRequest.current = controller;
    const current = () => lastFilterKey.current === key && !controller.signal.aborted;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const res = await fetch(`/api/site/timeline?${filterQuery(filters, { cursor: s.nextCursor })}`, { signal: controller.signal });
      if (res.status === 400) {
        // Cursor no longer fits: start over from the head.
        const head = await fetch(`/api/site/timeline?${key}`, { signal: controller.signal });
        if (!head.ok) throw new Error(String(head.status));
        if (current()) setState(fromResponse((await head.json()) as TimelineResponse));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as TimelineResponse;
      if (!current()) return;
      setState((prev) => {
        const seen = new Set(prev.cards.map((c) => c.key));
        const added = page.cards.filter((c) => !seen.has(c.key));
        setFreshKeys(new Set(added.map((c) => c.key)));
        return {
          ...prev,
          cards: [...prev.cards, ...added],
          nextCursor: page.nextCursor,
          dayCounts: { ...prev.dayCounts, ...page.dayCounts },
          batches: prev.batches + 1,
        };
      });
    } catch {
      if (current()) setLoadError(true);
    } finally {
      if (pageRequest.current === controller) {
        pageRequest.current = null;
        setLoadingMore(false);
      }
    }
  }, [filters]);

  // Auto-load a few batches when the sentinel nears the viewport, then hand over to a button.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !state.nextCursor || state.batches >= AUTO_BATCHES) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    }, { rootMargin: "900px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [state.nextCursor, state.batches, loadMore]);

  const today = beijingDate(Date.now());
  const days = useMemo(() => {
    const out: Array<{ day: string; cards: TimelineCard[] }> = [];
    for (const c of state.cards) {
      const d = beijingDate(c.anchorAt);
      const last = out[out.length - 1];
      if (last && last.day === d) last.cards.push(c);
      else out.push({ day: d, cards: [c] });
    }
    return out;
  }, [state.cards]);

  const toggleDay = (day: string) =>
    setState((s) => ({ ...s, collapsed: s.collapsed.includes(day) ? s.collapsed.filter((d) => d !== day) : [...s.collapsed, day] }));

  let order = 0;
  return (
    <div className="relative">
      {days.length === 0 && (
        <div className="lg:card">
          <EmptyState title="这个筛选下还没有精选内容">换个类别看看，或者去全部动态里找找。</EmptyState>
        </div>
      )}

      {days.map(({ day, cards }) => {
        const collapsed = state.collapsed.includes(day);
        const count = state.dayCounts[day] ?? cards.length;
        return (
          <section key={day} aria-label={day} className="lg:mb-1">
            <DayHeader day={day} today={today} count={count} collapsed={collapsed} onToggle={() => toggleDay(day)} />
            <Collapse open={!collapsed}>
                <ol className="lg:pt-1">
                  {cards.map((c) => {
                    const fresh = freshKeys.has(c.key);
                    const delay = fresh ? Math.min(order++, 10) * 40 : 0;
                    return (
                      <TimelineSlot key={c.key} dataKey={c.key} at={c.anchorAt} fresh={fresh} delay={delay}>
                        <FeedItem item={c.item} group={c.group} filters={filters} read={readSet.has(c.item.id)} onOpen={markRead} />
                      </TimelineSlot>
                    );
                  })}
                </ol>
            </Collapse>
          </section>
        );
      })}

      <div ref={sentinel} aria-hidden="true" />
      <FeedEnd loading={loadingMore} error={loadError} hasMore={!!state.nextCursor} manual={state.batches >= AUTO_BATCHES} empty={state.cards.length === 0} onMore={loadMore} />
    </div>
  );
}

/** The foot of a paged list: loading, retry, "加载更多" after a few automatic pages, or the end. */
export function FeedEnd({ loading, error, hasMore, manual, empty, onMore }: { loading: boolean; error: boolean; hasMore: boolean; manual: boolean; empty: boolean; onMore: () => void }) {
  return (
    <div className="flex justify-center py-6">
      {loading ? (
        <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-4">
          <RingMark className="size-4 text-accent" spinning /> 正在加载
        </span>
      ) : error ? (
        <button type="button" onClick={onMore} className="h-9 rounded-full border border-hot/30 px-4 text-[13px] text-hot hover:bg-hot-soft">
          加载失败，点此重试
        </button>
      ) : hasMore ? (
        manual && (
          <button type="button" onClick={onMore} className="h-9 rounded-full border border-line-strong bg-surface px-5 text-[13px] font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-ink">
            加载更多
          </button>
        )
      ) : (
        !empty && <span className="text-[12px] text-ink-4">已经到底了</span>
      )}
    </div>
  );
}
