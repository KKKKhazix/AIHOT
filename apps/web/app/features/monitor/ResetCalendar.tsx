import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CodexCalendarMark, CodexResetEvent, CodexResetDay } from "@aihot/contracts/monitor";
import { addDays } from "@aihot/contracts/time";
import { IconChevronRight } from "../../components/icons";
import { PostCard } from "./PostCard";
import { bjDate, dayWord, durationText, stamp, windowText } from "./format";
import { monthDay } from "../../lib/format";

// Day cells: a faint plain day, green for landed resets, a dashed green edge on white for "should have
// landed", warm sand for announced ones; the label chip repeats the tone.
const CELL: Record<CodexCalendarMark["state"], string> = {
  confirmed: "bg-cal-confirmed border-transparent",
  likely: "bg-surface border-dashed border-ok-ink/55",
  pending: "bg-cal-announced border-transparent",
};
const CHIP: Record<CodexCalendarMark["state"], string> = {
  confirmed: "bg-ok-ink/[0.14] text-ok-ink",
  likely: "text-ok-ink",
  pending: "bg-amber-ink/[0.16] text-amber-ink",
};
const STRENGTH: Record<CodexCalendarMark["state"], number> = { confirmed: 3, pending: 2, likely: 1 };

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function monthOf(date: string) {
  return date.slice(0, 7);
}

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Monday-first 6-week grid covering `month`. */
function gridDays(month: string): string[] {
  const first = `${month}-01`;
  const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(first, -weekday);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  // Drop a trailing week that belongs entirely to the next month.
  return days.slice(35).every((d) => monthOf(d) !== month) ? days.slice(0, 35) : days;
}

function statusChip(e: CodexResetEvent, now: number) {
  const s = e.presentation?.status ?? (e.status === "confirmed" ? "confirmed" : "announced");
  if (s === "confirmed") return { text: e.confirmationBasis === "receipt_review" ? "已核实到账" : "Tibo 已确认", tone: "text-ok-ink" };
  if (s === "likely_completed") return { text: "应已生效 · 未见确认帖", tone: "text-ok-ink" };
  if (s === "expired_unconfirmed") {
    const through = (e.estimate ?? e.schedule)?.through;
    return { text: through ? `晚于预计 ${durationText(now - Date.parse(through))} · 等待确认` : "晚于预计 · 等待确认", tone: "text-amber-ink" };
  }
  if (s === "in_progress") return { text: "正在发放", tone: "text-amber-ink" };
  return { text: "已宣布 · 等待生效", tone: "text-amber-ink" };
}

export function ResetCalendar({ marks, events, today, historyFrom, now, avatar, selectedDate, version }: { selectedDate: string; version: string; marks: CodexCalendarMark[]; events: CodexResetEvent[]; today: string; historyFrom: string | null; now: number; avatar: string | null }) {
  const latest = useMemo(() => [...marks].sort((a, b) => (a.date < b.date ? 1 : -1))[0]?.date ?? today, [marks, today]);
  const initial = selectedDate;
  const [selected, setSelected] = useState(initial);
  const [month, setMonth] = useState(monthOf(initial));
  // The grid slides in whenever the reader changes month, not on the first render.
  const firstMonth = useRef<string | null>(month);
  if (month !== firstMonth.current) firstMonth.current = null;
  const gridRef = useRef<HTMLDivElement>(null);
  const minMonth = historyFrom ? monthOf(historyFrom.slice(0, 10)) : "2026-06";
  const maxMonth = monthOf(today > latest ? today : latest);
  const byDay = useMemo(() => {
    const map = new Map<string, CodexCalendarMark[]>();
    for (const m of marks) map.set(m.date, [...(map.get(m.date) ?? []), m]);
    return map;
  }, [marks]);
  const [daysLoaded, setDaysLoaded] = useState<Record<string, CodexResetEvent[]>>({ [selectedDate]: events });
  const [failed, setFailed] = useState(false);
  useEffect(() => setDaysLoaded({ [selectedDate]: events }), [version, selectedDate, events]);
  const dayEvents = daysLoaded[selected] ?? [];
  const eventById = useMemo(() => new Map(dayEvents.map((e) => [e.id, e])), [dayEvents]);
  useEffect(() => {
    setFailed(false);
    if (daysLoaded[selected] || !marks.some((m) => m.date === selected)) return;
    const controller = new AbortController();
    fetch(`/api/site/codex-reset/days/${selected}`, { signal: controller.signal, cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error("day unavailable"); return r.json(); })
      .then((data: CodexResetDay) => {
        // The page or this day may predate the latest monitor update. Do not cache either mismatch;
        // the existing date link reloads both through SSR, without an automatic retry loop.
        if (data.version !== version) throw new Error("monitor version changed");
        if (!controller.signal.aborted) setDaysLoaded((old) => ({ ...old, [selected]: data.events }));
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [selected, version, marks, daysLoaded]);
  const inMonth = marks.filter((m) => monthOf(m.date) === month);
  const summary = [
    [inMonth.filter((m) => m.type === "direct_reset" && m.state !== "pending").length, "次额度重置"],
    [inMonth.filter((m) => m.type === "reset_credit" && m.state !== "pending").length, "次发重置卡"],
    [inMonth.filter((m) => m.state === "pending").length, "次等待生效"],
  ].filter(([n]) => (n as number) > 0);
  const days = gridDays(month);
  const selectedMarks = byDay.get(selected) ?? [];

  const select = (d: string) => {
    setSelected(d);
    if (monthOf(d) !== month) setMonth(monthOf(d));
  };
  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key as "ArrowLeft"];
    if (!step) return;
    e.preventDefault();
    const next = addDays(selected, step);
    if (monthOf(next) < minMonth || monthOf(next) > maxMonth) return;
    select(next);
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLAnchorElement>(`[data-day="${next}"]`)?.focus());
  };

  return (
    <section className="mt-8" aria-labelledby="calendar-title">
      <h2 id="calendar-title" className="text-[18px] font-bold text-ink">
        重置日历
      </h2>
      <p className="mt-1 text-[12.5px] text-ink-3">点日期查看当天的重置、发卡和 Tibo 原帖。</p>

      <noscript><nav aria-label="历史重置记录">{[...new Set(marks.map((m) => m.date))].sort().reverse().map((d) => <a key={d} href={`/codex-reset/history/${d}`} className="mr-3 inline-block">{d}</a>)}</nav></noscript>
      <div className="mt-4 overflow-hidden rounded-card border border-line-strong bg-surface lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,1fr)] xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]">
        <div className="px-3 py-[18px] sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="num text-[18px] font-[650] text-ink">
              {month.slice(0, 4)} 年 {Number(month.slice(5))} 月
            </span>
            <div className="flex items-center gap-0.5">
              {(selected !== today || month !== monthOf(today)) && (
                <button type="button" onClick={() => select(today)} aria-label="回到今天" className="mr-1 h-8 rounded-full px-3 text-[12px] text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink">
                  今天
                </button>
              )}
              {marks.length > 0 && (selected !== latest || month !== monthOf(latest)) && (
                <button type="button" onClick={() => select(latest)} className="mr-1 h-8 rounded-full px-3 text-[12px] text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink">
                  最近记录
                </button>
              )}
              <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= minMonth} aria-label="上个月" className="grid size-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink disabled:opacity-35">
                <IconChevronRight size={15} className="rotate-180" />
              </button>
              <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= maxMonth} aria-label="下个月" className="grid size-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink disabled:opacity-35">
                <IconChevronRight size={15} />
              </button>
            </div>
          </div>
          <p className="num mb-4 mt-3 text-[12px] text-ink-4">
            {summary.length ? (
              <>
                本月{" "}
                {summary.map(([n, t], i) => (
                  <span key={t as string}>
                    {i > 0 && " · "}
                    <strong className="font-semibold text-ink-3">{n}</strong> {t}
                  </span>
                ))}
              </>
            ) : (
              "本月没有记录"
            )}
          </p>

          <div ref={gridRef} role="grid" aria-label={`${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月重置记录，方向键可切换日期`} onKeyDown={onKey}>
            <div className="grid h-[26px] grid-cols-7 items-center gap-[3px] text-center text-[12px] text-ink-4 sm:gap-1" role="row">
              {WEEKDAYS.map((w) => (
                <span key={w} role="columnheader">
                  {w}
                </span>
              ))}
            </div>
            <div key={month} className={`mt-1 grid grid-cols-7 gap-[3px] sm:gap-1 ${firstMonth.current === null ? "anim-slide-in-x" : ""}`} role="rowgroup">
              {days.map((d) => {
                const ms = byDay.get(d) ?? [];
                const top = [...ms].sort((a, b) => STRENGTH[b.state] - STRENGTH[a.state])[0];
                const other = monthOf(d) !== month;
                const isSel = d === selected;
                const future = d > today;
                return (
                  <a
                    key={d}
                    href={`/codex-reset/history/${d}` }
                    role="gridcell"
                    data-day={d}
                    tabIndex={isSel ? 0 : -1}
                    aria-selected={isSel}
                    aria-label={`${d}${d === today ? "，今天" : ""}${ms.length ? `，${ms.map((m) => m.label).join("、")}` : ""}`}
                    onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); select(d); } }}
                    className={`relative flex min-h-[62px] flex-col items-center justify-start gap-1.5 rounded-control border px-0 pb-1.5 pt-2.5 transition-[background-color,border-color] duration-150 sm:min-h-[70px] sm:rounded-tile sm:px-0.5 ${
                      top ? CELL[top.state] : "border-transparent bg-cal-plain hover:border-line-strong hover:bg-bg-sunk"
                    } ${isSel ? "!border-[1.5px] !border-solid !border-accent shadow-[inset_0_0_0_1px_var(--surface)]" : ""} ${other ? "opacity-[0.38]" : ""}`}
                  >
                    <span className={`num relative text-[13px] font-medium leading-5 ${future && !top ? "text-ink-4" : "text-ink"}`}>
                      {Number(d.slice(8))}
                      {d === today && <span className="absolute -right-2 top-0.5 size-1 rounded-full bg-accent" aria-hidden="true" />}
                    </span>
                    {top && (
                      <span className={`max-w-full truncate rounded-full px-[3px] text-[10px] font-medium leading-4 sm:px-1.5 sm:text-[11px] ${CHIP[top.state]}`}>
                        {top.label}
                        {ms.length > 1 ? ` +${ms.length - 1}` : ""}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
            <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-ink-4">
              <li className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-mark bg-cal-key-confirmed" aria-hidden="true" />
                已生效（官方确认或到账核实）
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-mark border border-dashed border-ok-ink" aria-hidden="true" />
                应已生效（按预计时间，未见确认帖）
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-mark bg-cal-key-announced" aria-hidden="true" />
                已宣布，等待生效
              </li>
            </ul>
          </div>
        </div>

        <aside className="border-t border-line-strong bg-panel-quiet px-4 py-5 lg:border-l lg:border-t-0 lg:border-line lg:p-6" aria-live="polite">
          <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-line pb-4">
            <h3 className="text-[15px] font-[650] text-ink">
              {Number(selected.slice(5, 7))} 月 {Number(selected.slice(8))} 日
              {dayWord(selected, today) !== monthDay(selected) && <span className="ml-2 text-[12px] font-normal text-ink-4">{dayWord(selected, today)}</span>}
            </h3>
            <span className="num text-[12px] text-ink-4">{selected.slice(0, 4)}</span>
          </div>
          <p className="sr-only">
            已选择 {selected}，{selectedMarks.length} 条记录。
          </p>
          {selectedMarks.length > 0 && !daysLoaded[selected] && <p className="text-[13px] text-ink-3">{failed ? <a href={`/codex-reset/history/${selected}`} className="text-accent">重新读取当天记录</a> : "正在读取当天记录…"}</p>}
          {selectedMarks.map((m, i) => {
            const e = eventById.get(m.eventId);
            if (!e) return null;
            const chip = statusChip(e, now);
            const window = e.estimate ?? e.schedule;
            const post = e.posts[0];
            return (
              <article key={m.eventId} className={i > 0 ? "mt-6 border-t border-line pt-6" : ""}>
                <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${chip.tone}`}>
                  <span className="cr-dot !size-1.5 !shadow-none" aria-hidden="true" />
                  {chip.text}
                </span>
                <h4 className="mb-1 mt-2 text-[15px] font-bold leading-[1.6] text-ink">
                  {e.type === "reset_credit" ? "重置卡发放" : e.displayLabel === "额度重置" ? "Codex 额度重置" : e.displayLabel}
                </h4>
                {e.confirmedAt && (
                  <p className="num mb-1 text-[13px] font-medium text-ink">
                    确认帖 {stamp(e.confirmedAt)}
                    <span className="ml-1 font-normal text-ink-4">（不是精确到账时间）</span>
                  </p>
                )}
                {!e.confirmedAt && e.occurredOn && <p className="num mb-1 text-[13px] font-medium text-ink">核实到账 {monthDay(e.occurredOn)}</p>}
                {!e.confirmedAt && !e.occurredOn && e.confirmationBasis === "receipt_review" && (
                  <p className="mb-1 text-[13px] text-ink-4">具体到账日期未确定，日历日期不代表到账日期。</p>
                )}
                {window && e.status !== "confirmed" && (
                  <p className="mb-1 text-[13px] font-medium leading-[1.5] text-ink">
                    <span className="num">预计 {windowText(window.from, window.through, today)}</span>
                    {e.estimate?.reason && <span className="mt-0.5 block text-[12.5px] font-normal leading-[1.6] text-ink-3">{e.estimate.reason}</span>}
                  </p>
                )}
                <p className="text-[12px] leading-[1.7] text-ink-4">
                  适用范围：{e.presentation?.audienceZh ?? e.presentation?.scopeLabel ?? "原帖未说明适用人群"}
                  {e.presentation?.productsZh ? ` · ${e.presentation.productsZh}` : ""}
                </p>
                {post && (
                  <div className="mb-2 mt-3">
                    <PostCard compact avatar={avatar} stage={post.stage} post={{ id: post.id, publishedAt: post.publishedAt, translation: post.fullText ?? post.text, original: post.fullOriginalText ?? post.originalText, context: post.context, url: post.url }} />
                  </div>
                )}
                {e.posts.length > 1 && <EarlierPosts posts={e.posts.slice(1)} avatar={avatar} />}
              </article>
            );
          })}
          {!selectedMarks.length && (
            <div className="flex min-h-[300px] flex-col items-start justify-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-ink-4 opacity-60" aria-hidden="true">
                <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
                <path d="M3.5 9.5h17M8 3v4M16 3v4" />
              </svg>
              <h4 className="mt-4 text-[15px] font-semibold text-ink">这一天没有记录</h4>
              <p className="mb-5 mt-3 max-w-[280px] text-[12px] leading-[1.8] text-ink-4">暂未收录这一天的重置或发卡记录。点日历上带标签的日期查看已有记录。</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

/**
 * The rest of an event's evidence (the announcement behind a confirmation, a correction), newest first,
 * one tap away: every post the event rests on can be read.
 */
function EarlierPosts({ posts, avatar }: { posts: CodexResetEvent["posts"]; avatar: string | null }) {
  const [open, setOpen] = useState(false);
  const earliest = posts.at(-1)?.publishedAt ?? null;
  return (
    <div className="mt-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-[12px] text-ink-4 transition-colors hover:text-ink-2">
        <IconChevronRight size={12} className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        {open ? "收起" : `另有 ${posts.length} 条相关原帖`}
        {!open && earliest && bjDate(earliest) ? `，最早 ${stamp(earliest)}` : ""}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {posts.map((p) => (
            <PostCard key={p.id} compact avatar={avatar} stage={p.stage} post={{ id: p.id, publishedAt: p.publishedAt, translation: p.fullText ?? p.text, original: p.fullOriginalText ?? p.originalText, context: p.context, url: p.url }} />
          ))}
        </div>
      )}
    </div>
  );
}
