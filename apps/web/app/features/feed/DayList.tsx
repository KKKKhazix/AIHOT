// A page of reports grouped by Beijing day with the same rail and rows as the home timeline
// (全部动态, topics, search results).
import { useMemo } from "react";
import { Link } from "react-router";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { IconChevronRight } from "../../components/icons";
import { beijingDate } from "@aihot/contracts/time";
import { markRead, useReadSet } from "../../lib/local-state";
import { DayHeader, TimelineSlot } from "./Timeline";
import { FeedItem } from "./FeedItem";

export function DayList({ items, todayCount = null, headerAside }: { items: FeedItemSummary[]; todayCount?: number | null; headerAside?: React.ReactNode }) {
  const readSet = useReadSet();
  const today = beijingDate(Date.now());
  const days = useMemo(() => {
    const out: Array<{ day: string; items: FeedItemSummary[] }> = [];
    for (const it of items) {
      const d = beijingDate(it.timelineAt);
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(it);
      else out.push({ day: d, items: [it] });
    }
    return out;
  }, [items]);
  return (
    <div>
      {days.map(({ day, items: list }, i) => (
        <section key={day} aria-label={day}>
          <DayHeader day={day} today={today} count={day === today ? todayCount : null} aside={i === 0 ? headerAside : undefined} />
          <ol className="lg:pt-1">
            {list.map((it) => (
              <TimelineSlot key={it.id} at={it.timelineAt}>
                <FeedItem item={it} read={readSet.has(it.id)} onOpen={markRead} showTags at={it.timelineAt} />
              </TimelineSlot>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/**
 * Numbered pages (the list stays crawlable), with previous / next at the ends. Phones show previous,
 * "2 / 50" and next as large buttons; the numbers stay in the page for crawlers.
 */
export function Pagination({ page, pageCount, href }: { page: number; pageCount: number; href: (p: number) => string }) {
  if (pageCount <= 1) return null;
  const pages = [...new Set([1, pageCount, page - 2, page - 1, page, page + 1, page + 2].filter((p) => p >= 1 && p <= pageCount))].sort((a, b) => a - b);
  const btn = "inline-flex h-9 min-w-9 items-center justify-center rounded-full px-2.5 text-[13px] transition-colors";
  return (
    <nav aria-label="分页" className="mt-6 flex flex-wrap items-center justify-center gap-3 lg:gap-1">
      {page > 1 && (
        <Link to={href(page - 1)} className={`${btn} h-11 border border-line-strong bg-surface px-5 text-[14px] text-ink-2 active:bg-bg-sunk lg:h-9 lg:px-3 lg:text-[13px] lg:text-ink-3 lg:hover:border-ink-4 lg:hover:text-ink`}>
          上一页
        </Link>
      )}
      <span className="num px-1 text-[13px] text-ink-4 lg:hidden">
        {page} / {pageCount}
      </span>
      {pages.map((p, i) => (
        <span key={p} className="hidden items-center gap-1 lg:flex">
          {i > 0 && p - pages[i - 1]! > 1 && <span className="px-0.5 text-ink-4">…</span>}
          <Link
            to={href(p)}
            aria-current={p === page ? "page" : undefined}
            className={`num ${btn} ${p === page ? "bg-ink font-semibold text-bg" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
          >
            {p}
          </Link>
        </span>
      ))}
      {page < pageCount && (
        <Link to={href(page + 1)} className={`${btn} h-11 gap-0.5 border border-line-strong bg-surface px-5 text-[14px] text-ink-2 active:bg-bg-sunk lg:h-9 lg:px-3 lg:text-[13px] lg:text-ink-3 lg:hover:border-ink-4 lg:hover:text-ink`}>
          下一页 <IconChevronRight size={14} />
        </Link>
      )}
    </nav>
  );
}
