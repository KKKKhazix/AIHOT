// A topic's 大事记 in two forms: a company's milestones on a horizontal chronicle, the kinds the industry
// pack puts above the axis (the AI pack: models) on the track above it and the rest below; a direction's
// or a form's months on a vertical rail. Both mark each milestone's kind the same way, as the page's
// `kinds` describe it.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { TopicEvent, TopicKind, TopicMilestone, TopicMilestoneKind, TopicMonth } from "@aihot/contracts/site";
import { IconArrowUpRight, IconChevronDown, IconChevronLeft, IconChevronRight } from "../../components/icons";
import { beijingDate } from "@aihot/contracts/time";

type Kinds = Record<TopicMilestoneKind, TopicKind>;

/** The kind's mark on the axis or the rail: the kind above the axis solid, a launch an accent ring, the rest a grey ring. */
function Dot({ kind, className = "", style }: { kind: TopicKind; className?: string; style?: React.CSSProperties }) {
  const look = kind.above ? "size-[11px] bg-accent" : `size-[9px] border-2 bg-surface ${kind.launch ? "border-accent" : "border-ink-4/70"}`;
  return <span aria-hidden="true" style={style} className={`rounded-full shadow-[0_0_0_3px_var(--surface)] ${look} ${className}`} />;
}

const kindText = (kind: TopicKind) => (kind.above ? "font-semibold text-accent" : "text-ink-4");

function Header({ sub, children }: { sub: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id="topic-chronicle" className="text-[16px] font-semibold text-ink">大事记</h2>
        <span className="text-[12px] text-ink-4">{sub}</span>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// The horizontal chronicle: one time axis, oldest on the left. The scroller runs right to left, so the
// page opens on its newest end without waiting for script; older years are a scroll away.

type Lane = "above" | "below";
interface Placed { ms: TopicMilestone; kind: TopicKind; lane: Lane; col: number }

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) || 1);

/**
 * Columns of the band, in time order: a milestone takes the next column (a card spans two of its
 * track's), and a new month (a year, over a long history) takes one of the axis before it.
 */
function layout(milestones: TopicMilestone[], kinds: Kinds) {
  const byYear = monthIndex(milestones.at(-1)!.date) - monthIndex(milestones[0]!.date) > 18;
  const placed: Placed[] = [];
  const marks: Array<{ label: string; col: number }> = [];
  const free: Record<Lane, number> = { above: 0, below: 0 };
  let last = -1;
  let mark: string | null = null;
  let year: string | null = null;
  for (const ms of milestones) {
    const kind = kinds[ms.kind];
    const lane: Lane = kind.above ? "above" : "below";
    const [y, m] = [ms.date.slice(0, 4), ms.date.slice(5, 7)];
    const key = byYear || !m ? y : `${y}-${m}`;
    const opens = key !== mark;
    const col = Math.max(last + (opens ? 2 : 1), free[lane]);
    if (opens) {
      marks.push({ col: col - 1, label: byYear || !m ? y : y !== year ? `${y}年${Number(m)}月` : `${Number(m)}月` });
      mark = key;
      year = y;
    }
    placed.push({ ms, kind, lane, col });
    free[lane] = col + 2;
    last = col;
  }
  return { placed, marks, columns: Math.max(free.above, free.below), byYear };
}

/** "11月30日", "2022年11月", "2022年": the year only when it is not the newest milestone's. */
function dateLabel(date: string, newestYear: string): string {
  const [y, m, d] = date.split("-");
  const year = y !== newestYear || !m ? `${y}年` : "";
  return `${year}${m ? `${Number(m)}月` : ""}${d ? `${Number(d)}日` : ""}`;
}

/**
 * A milestone's card, all of one height: its date and kind over its name. The report's headline (or a
 * curated summary) shows on hover.
 */
function BandCard({ ms, kind, newestYear, style }: { ms: TopicMilestone; kind: TopicKind; newestYear: string; style: React.CSSProperties }) {
  const above = kind.above;
  // The scroller runs right to left; the card itself reads left to right in every engine.
  const className = `group/event mr-3 flex h-[82px] max-w-[264px] flex-col rounded-tile border px-3 py-2.5 text-left transition-colors ${above ? "self-end" : "self-start"} ${
    above ? "border-line bg-surface shadow-card" : "border-line-soft bg-bg-sunk/45 dark:bg-bg-muted/25"
  } ${ms.href ? (above ? "hover:border-accent/50" : "hover:border-line hover:bg-bg-sunk") : ""}`;
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-[11.5px] leading-4">
        <span className="num font-semibold text-ink-3">{dateLabel(ms.date, newestYear)}</span>
        <span className={kindText(kind)}>{kind.label}</span>
        {ms.external && <IconArrowUpRight size={12} className="text-ink-4" aria-label="站外原文" />}
      </span>
      <span
        className={`mt-1 line-clamp-2 text-[13px] leading-5 transition-colors sm:text-[13.5px] ${ms.href ? "group-hover/event:text-accent" : ""} ${
          above || ms.major ? "font-semibold text-ink" : "text-ink-2"
        }`}
      >
        {ms.title}
      </span>
    </>
  );
  const hover = ms.summary ?? ms.headline ?? undefined;
  if (ms.href === null) return <div dir="ltr" style={style} title={hover} className={className}>{body}</div>;
  if (ms.external) return <a dir="ltr" style={style} title={hover} href={ms.href} target="_blank" rel="noopener noreferrer" className={className}>{body}</a>;
  return <Link viewTransition dir="ltr" style={style} title={hover} to={ms.href} className={className}>{body}</Link>;
}

const PAGE_BUTTON =
  "inline-flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink-3 transition-colors hover:border-line-strong hover:text-ink disabled:pointer-events-none disabled:opacity-35 lg:size-8";

/** 大事记 of a company: the kinds above the axis over it, the rest below, the newest end in view. */
export function ChronicleBand({ milestones, kinds }: { milestones: TopicMilestone[]; kinds: Kinds }) {
  const scroller = useRef<HTMLDivElement>(null);
  // Until script runs the page shows the newest end, the one with nothing newer.
  const [room, setRoom] = useState({ older: false, newer: false });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Right to left: 0 at the newest end, negative towards the older one.
    const update = () => {
      const back = Math.abs(el.scrollLeft);
      setRoom({ older: back < el.scrollWidth - el.clientWidth - 2, newer: back > 2 });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, []);
  if (milestones.length === 0) return null;
  const page = (towards: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: towards * el.clientWidth * 0.75, behavior: instant ? "auto" : "smooth" });
  };
  const { placed, marks, columns, byYear } = layout(milestones, kinds);
  const first = milestones[0]!.date;
  const newestYear = milestones.at(-1)!.date.slice(0, 4);
  const since = byYear || first.length === 4 ? `${first.slice(0, 4)} 年` : `${first.slice(0, 4)} 年 ${Number(first.slice(5, 7))} 月`;
  // Rows: the track above (cards, stems), the axis, the track below (stems, cards); an empty track is left out.
  const aboveTrack = placed.some((p) => p.lane === "above");
  const belowTrack = placed.some((p) => p.lane === "below");
  let row = 1;
  const rows = { aboveCards: aboveTrack ? row++ : 0, aboveStems: aboveTrack ? row++ : 0, axis: row++, belowStems: belowTrack ? row++ : 0, belowCards: belowTrack ? row++ : 0 };
  const template = [aboveTrack && "auto 22px", "28px", belowTrack && "22px auto"].filter(Boolean).join(" ");
  return (
    <section aria-labelledby="topic-chronicle" className="card pb-3 pt-3.5 lg:pt-4">
      <div className="px-4 lg:px-5">
        <Header sub={`${since}至今`}>
          {(room.older || room.newer) && (
            <div className="hidden shrink-0 gap-1.5 sm:flex">
              <button type="button" aria-label="更早的大事" disabled={!room.older} onClick={() => page(-1)} className={PAGE_BUTTON}>
                <IconChevronLeft size={16} />
              </button>
              <button type="button" aria-label="更近的大事" disabled={!room.newer} onClick={() => page(1)} className={PAGE_BUTTON}>
                <IconChevronRight size={16} />
              </button>
            </div>
          )}
        </Header>
      </div>
      <div
        ref={scroller}
        dir="rtl"
        role="region"
        aria-label="大事记时间轴"
        tabIndex={0}
        className="scrollbar-none mt-3 overflow-x-auto overscroll-x-contain [mask-image:linear-gradient(to_right,transparent,#000_16px,#000_calc(100%-16px),transparent)] focus-visible:outline-offset-[-2px] sm:[mask-image:linear-gradient(to_right,transparent,#000_24px,#000_calc(100%-24px),transparent)]"
      >
        {/* A spacer before the oldest column keeps a short history at the newest end; the last column holds "至今".
            On a phone three columns fill the width, so the newest cards above and below the axis are both in full view. */}
        <ol
          dir="ltr"
          className="grid w-max min-w-full px-4 [--slot:clamp(84px,calc((100vw_-_100px)/3),118px)] sm:px-5 sm:[--slot:118px]"
          style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${columns}, var(--slot)) auto`, gridTemplateRows: template }}
        >
          <li aria-hidden="true" className="h-px self-center bg-line-strong" style={{ gridRow: rows.axis, gridColumn: "1 / -1" }} />
          {marks.map((m) => (
            <li key={`m${m.col}`} aria-hidden="true" className="num z-[1] self-center justify-self-center whitespace-nowrap rounded-full border border-line-strong bg-surface px-2.5 py-[3px] text-[12px] font-semibold leading-4 text-ink-2" style={{ gridRow: rows.axis, gridColumn: m.col + 2 }}>
              {m.label}
            </li>
          ))}
          <li aria-hidden="true" className="z-[1] self-center justify-self-end bg-surface pl-2 text-[11.5px] text-ink-4" style={{ gridRow: rows.axis, gridColumn: columns + 2 }}>
            至今
          </li>
          {placed.map(({ ms, kind, lane, col }) => (
            <li key={col} className="contents">
              <BandCard ms={ms} kind={kind} newestYear={newestYear} style={{ gridRow: lane === "above" ? rows.aboveCards : rows.belowCards, gridColumn: `${col + 2} / span 2` }} />
              <span aria-hidden="true" className={`ml-[19.5px] w-px ${lane === "above" ? "bg-accent/45" : "bg-line-strong"}`} style={{ gridRow: lane === "above" ? rows.aboveStems : rows.belowStems, gridColumn: col + 2 }} />
              <Dot kind={kind} className={`z-[1] self-center justify-self-start ${kind.above ? "ml-[14.5px]" : "ml-[15.5px]"}`} style={{ gridRow: rows.axis, gridColumn: col + 2 }} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// The vertical rail: a direction's or a form's months, newest first.

// The rail's four columns: the day (or the month), the rail, the kind, the event.
const RAIL_ROW = "grid grid-cols-[38px_18px_30px_minmax(0,1fr)] sm:grid-cols-[48px_22px_34px_minmax(0,1fr)]";

const dayOf = (iso: string) => Number(beijingDate(iso).slice(8));

/** A month in the chronicle: "9月" in the newest month's year, "2025年12月" before it. */
function monthLabel(month: string, newest: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return month.slice(0, 4) === newest.slice(0, 4) ? `${m}月` : `${y}年${m}月`;
}

/** An event on the rail: its day, its kind's dot and name, the event's name (the headline on hover). The month's last event ends the rail. */
function RailEvent({ e, kind, last }: { e: TopicEvent; kind: TopicKind; last: boolean }) {
  return (
    <li className={RAIL_ROW}>
      <time dateTime={e.at} className="num pt-[8px] text-right text-[12px] leading-5 text-ink-4 sm:text-[12.5px]">
        {dayOf(e.at)}日
      </time>
      <span aria-hidden="true" className="relative">
        <span className={`absolute left-1/2 top-0 w-px -translate-x-1/2 bg-line-strong ${last ? "h-[18px]" : "bottom-0"}`} />
        <Dot kind={kind} className="absolute left-1/2 top-[18px] -translate-x-1/2 -translate-y-1/2" />
      </span>
      <span className={`pt-[8px] text-[12px] leading-5 ${kindText(kind)}`}>{kind.label}</span>
      <Link
        viewTransition
        to={e.href}
        title={e.label === e.title ? undefined : e.title}
        className="group/event min-h-11 min-w-0 rounded-tile px-2 py-[7px] transition-colors hover:bg-bg-sunk/70 active:bg-bg-sunk lg:min-h-0 dark:hover:bg-bg-muted/40"
      >
        <span className={`text-[14px] leading-[1.6] transition-colors group-hover/event:text-accent ${kind.above ? "font-semibold text-ink" : "text-ink-2"}`}>{e.label}</span>
      </Link>
    </li>
  );
}

/** A month on the rail: its name beside a ring, then its events; each month is one stretch of rail. */
function RailMonth({ month, newest, kinds }: { month: TopicMonth; newest: string; kinds: Kinds }) {
  const [year, m] = month.month.split("-").map(Number) as [number, number];
  const otherYear = month.month.slice(0, 4) !== newest.slice(0, 4);
  return (
    <section aria-label={monthLabel(month.month, newest)} className="pb-3">
      <div className={`${RAIL_ROW} items-center`}>
        <h3 className="text-right text-[14px] font-semibold leading-tight text-ink sm:text-[15px]">
          {otherYear && <span className="num block text-[11px] font-normal text-ink-4">{year}</span>}
          {m}月
        </h3>
        <span aria-hidden="true" className="relative h-9">
          <span className="absolute bottom-0 left-1/2 top-1/2 w-px -translate-x-1/2 bg-line-strong" />
          <span className="absolute left-1/2 top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-line-strong bg-surface" />
        </span>
      </div>
      <ol>
        {month.events.map((e, i) => (
          <RailEvent key={e.id} e={e} kind={kinds[e.kind]} last={i === month.events.length - 1} />
        ))}
      </ol>
    </section>
  );
}

/** Show a short set of recent events; the complete history remains in the document. */
const OPEN_EVENTS = 5;

/** 大事记 of a direction or a form: qualifying events on one rail, newest first. */
export function ChronicleRail({ months, kinds }: { months: TopicMonth[]; kinds: Kinds }) {
  const visible: TopicMonth[] = [];
  const earlier: TopicMonth[] = [];
  let remaining = OPEN_EVENTS;
  for (const month of months) {
    const count = Math.min(remaining, month.events.length);
    if (count > 0) visible.push({ ...month, events: month.events.slice(0, count) });
    if (count < month.events.length) earlier.push({ ...month, events: month.events.slice(count) });
    remaining -= count;
  }
  if (visible.length === 0) return null;
  const newest = visible[0]!.month;
  const earlierCount = earlier.reduce((count, month) => count + month.events.length, 0);
  return (
    <section aria-labelledby="topic-chronicle" className="card px-4 pb-1.5 pt-3.5 lg:px-5 lg:pt-4">
      <Header sub="重要进展" />
      <div className="mt-2">
        {visible.map((m) => (
          <RailMonth key={m.month} month={m} newest={newest} kinds={kinds} />
        ))}
      </div>
      {earlier.length > 0 && (
        <details className="disclosure group/earlier border-t border-line">
          <summary className="-mx-2 flex min-h-11 items-center justify-center gap-1 rounded-tile py-2.5 text-[12.5px] text-ink-3 transition-colors hover:text-accent lg:min-h-0">
            <span className="group-open/earlier:hidden">查看更早 {earlierCount} 件大事</span>
            <span className="hidden group-open/earlier:inline">收起</span>
            <IconChevronDown size={14} className="transition-transform duration-200 group-open/earlier:rotate-180" />
          </summary>
          <div className="pt-3">
            {earlier.map((m) => (
              <RailMonth key={m.month} month={m} newest={newest} kinds={kinds} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
