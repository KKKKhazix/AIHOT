import { useId, useMemo, useState, type ReactNode } from "react";
import type { HeatPoint } from "@aihot/contracts/site";
import { BEIJING_OFFSET_MS, beijingDate, beijingTime } from "@aihot/contracts/time";
import { formatCount, monthDay, monthDayTime } from "../../lib/format";
import { useEntrance } from "../../lib/hydration";
import { L, useLocale, useT, type Locale } from "../../lib/i18n";
import { PillTabs } from "../../components/ui/Tabs";
import { areaPath, curvePath, type Pt } from "../hot/curve";
import { useSwapped } from "../../lib/motion";

const HOUR = 3600 * 1000;
const BEIJING = BEIJING_OFFSET_MS;

function niceStep(max: number): number {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  return ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw) || 1;
}

/**
 * Hourly heat of one story over its comparable range. Hours that were not fully observed leave a gap
 * instead of being drawn as zero; with fewer than three observed hours there is no chart. The curve is
 * drawn in a stretchable SVG and every label is page text, so the axes stay legible on a phone.
 */
const RANGES = [
  { hours: 24, label: L("24 小时", "24 hours") },
  { hours: 72, label: L("3 天", "3 days") },
  { hours: 168, label: L("7 天", "7 days") },
] as const;

const num = formatCount;

/** The points of the last `hours` before the latest one. */
function inRange(points: HeatPoint[], hours: number): HeatPoint[] {
  if (!points.length) return [];
  const end = Date.parse(points[points.length - 1]!.hour);
  return points.filter((p) => Date.parse(p.hour) >= end - hours * HOUR);
}

/** Only ranges that show a different set of points (a young story fills one range at most). */
function distinctRanges(points: HeatPoint[]) {
  const seen = new Set<string>();
  return RANGES.filter((r) => {
    const shown = inRange(points, r.hours);
    const key = `${shown.length}:${shown[0]?.hour ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Time labels on whole Beijing hours: the finest step that leaves at most six; midnight reads as the
 * date. Beyond four, a phone shows every other one (`wide`: only from sm up).
 */
function timeTicks(t0: number, t1: number, locale: Locale): Array<{ t: number; label: string; wide: boolean }> {
  const span = (t1 - t0) / HOUR;
  const step = ([1, 2, 3, 6, 12, 24, 48].find((s) => span / s <= 6) ?? 72) * HOUR;
  const out: Array<{ t: number; label: string; wide: boolean }> = [];
  for (let t = Math.ceil((t0 + BEIJING) / step) * step - BEIJING; t <= t1; t += step) {
    const time = beijingTime(t);
    out.push({ t, label: time === "00:00" ? monthDay(beijingDate(t), undefined, locale) : time, wide: Math.round((t + BEIJING) / step) % 2 === 1 });
  }
  if (out.length <= 4) for (const tick of out) tick.wide = false;
  return out;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ui-caption text-ink-4">{label}</dt>
      <dd className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">{children}</dd>
    </div>
  );
}

export function HeatChart({ points: all }: { points: HeatPoint[] }) {
  const t = useT();
  const locale = useLocale();
  const wash = `heat${useId().replace(/[^\w-]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const ranges = useMemo(() => distinctRanges(all), [all]);
  const [hours, setHours] = useState<number>(168);
  const range = ranges.find((r) => r.hours === hours) ?? ranges[ranges.length - 1];
  // Another time range redraws the curve in place: the new one fades in over where the old one was.
  const switched = useSwapped(range?.hours ?? null);
  const points = useMemo(() => inRange(all, range?.hours ?? 168), [all, range]);
  const entrance = useEntrance();

  const series = useMemo(() => {
    if (points.length === 0) return [];
    const byHour = new Map(points.map((p) => [Date.parse(p.hour), p]));
    const start = Date.parse(points[0]!.hour);
    const end = Date.parse(points[points.length - 1]!.hour);
    const out: Array<{ t: number; p: HeatPoint | null }> = [];
    for (let t = start; t <= end; t += HOUR) out.push({ t, p: byHour.get(t) ?? null });
    return out;
  }, [points]);
  const geometry = useMemo(() => {
    const seen = series.filter((s) => s.p);
    if (seen.length < 3) return null;

    const last = seen[seen.length - 1]!;
    const peak = seen.reduce((a, b) => (b.p!.heat > a.p!.heat ? b : a));
    const dayAgo = series.find((s) => s.t === last.t - 24 * HOUR)?.p;
    const change = dayAgo && dayAgo.heat > 0 ? Math.round(((last.p!.heat - dayAgo.heat) / dayAgo.heat) * 100) : null;

    const step = niceStep(peak.p!.heat);
    const top = Math.max(step, Math.ceil(peak.p!.heat / step) * step);
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
    const t0 = series[0]!.t;
    const t1 = series[series.length - 1]!.t;
    const span = Math.max(HOUR, t1 - t0);
    // Both axes in percent of the plot box: the SVG stretches to it, the labels and dots sit on it.
    const x = (t: number) => ((t - t0) / span) * 100;
    const y = (v: number) => (1 - v / top) * 100;

    // Runs of consecutive observed hours become separate curve and wash pieces.
    const runs: Pt[][] = [];
    let run: Pt[] = [];
    for (const s of series) {
      if (s.p) run.push([x(s.t), y(s.p.heat)]);
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);
    const line = runs.map(curvePath).join("");
    const area = runs.map((r) => areaPath(r, 100)).join("");
    return { seen, last, peak, change, ticks, x, y, line, area, labels: timeTicks(t0, t1, locale) };
  }, [series, locale]);
  if (!geometry) {
    return <p className="rounded-tile bg-bg-sunk px-4 py-8 text-center text-ui-label text-ink-4">{t("数据还在积累中，暂时画不出趋势。", "Not enough data yet to draw a trend.")}</p>;
  }
  const { seen, last, peak, change, ticks, x, y, line, area, labels } = geometry;
  const cur = active !== null ? seen[active] : null;
  const pick = (clientX: number, rect: DOMRect) => {
    const px = ((clientX - rect.left) / rect.width) * 100;
    let best = 0;
    seen.forEach((s, i) => {
      if (Math.abs(x(s.t) - px) < Math.abs(x(seen[best]!.t) - px)) best = i;
    });
    setActive(best);
  };
  const at = (s: { t: number; p: HeatPoint | null }) => ({ left: `${x(s.t)}%`, top: `${y(s.p!.heat)}%` });

  return (
    <div>
      <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-start sm:justify-between">
        <dl className="grid grid-cols-3 gap-x-5 sm:flex sm:gap-x-10">
          <Stat label={t("当前热度", "Now")}>
            <span className="mono text-ui-heading-lg-sm font-semibold leading-none tracking-[-0.02em] text-ink">{num(Math.round(last.p!.heat), locale)}</span>
          </Stat>
          <Stat label={t("最高热度", "Peak")}>
            <span className="mono text-ui-heading-lg-sm font-semibold leading-none tracking-[-0.02em] text-ink">{num(Math.round(peak.p!.heat), locale)}</span>
            <span className="num text-ui-caption text-ink-4">{monthDayTime(new Date(peak.t).toISOString(), locale)}</span>
          </Stat>
          <Stat label={t("近 24 小时变化", "24-hour change")}>
            <span className={`mono text-ui-heading-lg-sm font-semibold leading-none tracking-[-0.02em] ${change === null ? "text-ink-4" : change > 0 ? "text-hot" : "text-ink"}`}>
              {change === null ? "–" : `${change > 0 ? "+" : ""}${change}%`}
            </span>
          </Stat>
        </dl>
        {ranges.length > 1 && (
          <PillTabs
            size="xs"
            layoutId="heat-range"
            label={t("时间范围", "Time range")}
            active={String(range!.hours)}
            onSelect={(key) => {
              setActive(null);
              setHours(Number(key));
            }}
            items={ranges.map((r) => ({ key: String(r.hours), label: t(r.label) }))}
            className="self-start"
          />
        )}
      </div>

      <div className="relative mt-6 h-[176px] pl-9 sm:h-[216px] lg:h-[236px]">
        {ticks.map((v) => (
          <span key={v} className="num absolute left-0 w-7 -translate-y-1/2 text-right text-ui-caption-sm leading-none text-ink-4" style={{ top: `${y(v)}%` }} aria-hidden="true">
            {num(v, locale)}
          </span>
        ))}
        <div
          className="relative size-full touch-pan-y select-none rounded-mark outline-offset-4"
          role="img"
          aria-label={t(`热度走势：当前热度 ${Math.round(last.p!.heat)}，最高热度 ${Math.round(peak.p!.heat)}`, `Heat over time: now ${num(Math.round(last.p!.heat), locale)}, peak ${num(Math.round(peak.p!.heat), locale)}`)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setActive((a) => Math.min(seen.length - 1, a === null ? seen.length - 1 : a + 1));
            else if (e.key === "ArrowLeft") setActive((a) => Math.max(0, a === null ? seen.length - 1 : a - 1));
            else if (e.key === "Escape") setActive(null);
            else return;
            e.preventDefault();
          }}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
          onBlur={() => setActive(null)}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
            {ticks.map((v) => (
              <line key={v} x1="0" x2="100" y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--line-strong)" : "var(--line-soft)"} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          <svg key={range!.hours} viewBox="0 0 100 100" preserveAspectRatio="none" className={`absolute inset-0 size-full overflow-visible text-accent ${switched ? "anim-fade-in" : entrance ? "anim-reveal" : ""}`} aria-hidden="true">
            <defs>
              <linearGradient id={wash} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.2" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${wash})`} />
            <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {/* The reading under the pointer fades in once, then follows the pointer as it moves. */}
          {cur && (
            <>
              <span className="anim-fade-in pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-line-strong" style={{ left: `${x(cur.t)}%` }} />
              <span className="anim-fade-in pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface" style={at(cur)} />
            </>
          )}
          {/* The latest reading stays on the curve's end: it steps aside while the pointer reads the curve and is back
              at once after, its first appearance waiting for the curve to be drawn to it. */}
          <span className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-opacity ${cur ? "opacity-0" : ""}`} style={at(last)}>
            <span className={`grid size-5 place-items-center rounded-full bg-accent/20 ${entrance ? "anim-fade-in" : ""}`} style={entrance ? { animationDelay: "650ms" } : undefined}>
              <span className="size-2.5 rounded-full bg-accent ring-2 ring-surface" />
            </span>
          </span>
          {cur && (
            <div
              className="anim-fade-in pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-control border border-line bg-raised px-2.5 py-1.5 text-ui-caption shadow-[var(--shadow-pop)]"
              style={x(cur.t) > 55 ? { right: `calc(${100 - x(cur.t)}% + 10px)` } : { left: `calc(${x(cur.t)}% + 10px)` }}
            >
              <div className="num text-ink-4">{monthDayTime(new Date(cur.t).toISOString(), locale)}</div>
              <div className="text-ink-2">
                {t("热度 ", "Heat ")}<b className="num font-semibold text-ink">{t(cur.p!.heat.toFixed(1), cur.p!.heat.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }))}</b>
                <span className="mx-1 text-ink-4">·</span>
                <span className="num">{num(cur.p!.participants, locale)}</span>{t(" 位参与者", cur.p!.participants === 1 ? " participant" : " participants")}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="relative ml-9 mt-2.5 h-4" aria-hidden="true">
        {labels.map(({ t, label, wide }) => {
          const left = x(t);
          return (
            <span
              key={t}
              className={`num absolute whitespace-nowrap text-ui-caption-sm leading-none text-ink-4 ${left < 6 ? "" : left > 94 ? "-translate-x-full" : "-translate-x-1/2"} ${wide ? "max-sm:hidden" : ""}`}
              style={{ left: `${left}%` }}
            >
              {label}
            </span>
          );
        })}
      </div>
      <p className="mt-4 text-ui-caption leading-relaxed text-ink-4">
        {t(
          "曲线仅统计同一批持续追踪的来源，数值可能与实时总热度不同。",
          "This chart only tracks a consistent set of sources, so its numbers may differ from the live total heat.",
        )}
      </p>
    </div>
  );
}
