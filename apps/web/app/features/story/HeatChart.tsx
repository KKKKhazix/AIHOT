import { useId, useMemo, useState, type ReactNode } from "react";
import type { HeatPoint } from "@aihot/contracts/site";
import { monthDayTime } from "../../lib/format";
import { useEntrance } from "../../lib/hydration";
import { PillTabs } from "../../components/ui/Tabs";
import { areaPath, curvePath, type Pt } from "../hot/curve";

const HOUR = 3600 * 1000;
const BEIJING = 8 * HOUR;

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
  { hours: 24, label: "24 小时" },
  { hours: 72, label: "3 天" },
  { hours: 168, label: "7 天" },
] as const;

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
function timeTicks(t0: number, t1: number): Array<{ t: number; label: string; wide: boolean }> {
  const span = (t1 - t0) / HOUR;
  const step = ([1, 2, 3, 6, 12, 24, 48].find((s) => span / s <= 6) ?? 72) * HOUR;
  const out: Array<{ t: number; label: string; wide: boolean }> = [];
  for (let t = Math.ceil((t0 + BEIJING) / step) * step - BEIJING; t <= t1; t += step) {
    const [day, time] = monthDayTime(new Date(t).toISOString()).split(" ");
    out.push({ t, label: time === "00:00" ? day! : time!, wide: Math.round((t + BEIJING) / step) % 2 === 1 });
  }
  if (out.length <= 4) for (const tick of out) tick.wide = false;
  return out;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-4">{label}</dt>
      <dd className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">{children}</dd>
    </div>
  );
}

export function HeatChart({ points: all }: { points: HeatPoint[] }) {
  const wash = `heat${useId().replace(/[^\w-]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const ranges = useMemo(() => distinctRanges(all), [all]);
  const [hours, setHours] = useState<number>(168);
  const range = ranges.find((r) => r.hours === hours) ?? ranges[ranges.length - 1];
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
    return { seen, last, peak, change, ticks, x, y, line, area, labels: timeTicks(t0, t1) };
  }, [series]);
  if (!geometry) {
    return <p className="rounded-tile bg-bg-sunk px-4 py-8 text-center text-[13px] text-ink-4">还没有足够的连续观测数据，暂不绘制趋势。</p>;
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
          <Stat label="可比范围当前">
            <span className="mono text-[22px] font-semibold leading-none tracking-[-0.02em] text-ink">{Math.round(last.p!.heat)}</span>
          </Stat>
          <Stat label="可比范围峰值">
            <span className="mono text-[22px] font-semibold leading-none tracking-[-0.02em] text-ink">{Math.round(peak.p!.heat)}</span>
            <span className="num text-[12px] text-ink-4">{monthDayTime(new Date(peak.t).toISOString())}</span>
          </Stat>
          <Stat label="近 24 小时变化">
            <span className={`mono text-[22px] font-semibold leading-none tracking-[-0.02em] ${change === null ? "text-ink-4" : change > 0 ? "text-hot" : "text-ink"}`}>
              {change === null ? "–" : `${change > 0 ? "+" : ""}${change}%`}
            </span>
          </Stat>
        </dl>
        {ranges.length > 1 && (
          <PillTabs
            size="xs"
            layoutId="heat-range"
            label="时间范围"
            active={String(range!.hours)}
            onSelect={(key) => {
              setActive(null);
              setHours(Number(key));
            }}
            items={ranges.map((r) => ({ key: String(r.hours), label: r.label }))}
            className="self-start"
          />
        )}
      </div>

      <div className="relative mt-6 h-[176px] pl-9 sm:h-[216px] lg:h-[236px]">
        {ticks.map((v) => (
          <span key={v} className="num absolute left-0 w-7 -translate-y-1/2 text-right text-[11px] leading-none text-ink-4" style={{ top: `${y(v)}%` }} aria-hidden="true">
            {v}
          </span>
        ))}
        <div
          className="relative size-full touch-pan-y select-none rounded-mark outline-offset-4"
          role="img"
          aria-label={`热度走势：当前 ${Math.round(last.p!.heat)}，峰值 ${Math.round(peak.p!.heat)}`}
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
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={`absolute inset-0 size-full overflow-visible text-accent ${entrance ? "anim-reveal" : ""}`} aria-hidden="true">
            <defs>
              <linearGradient id={wash} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.2" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${wash})`} />
            <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {cur ? (
            <>
              <span className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-line-strong" style={{ left: `${x(cur.t)}%` }} />
              <span className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface" style={at(cur)} />
            </>
          ) : (
            <span className={`pointer-events-none absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-accent/20 ${entrance ? "anim-fade-in" : ""}`} style={{ ...at(last), ...(entrance ? { animationDelay: "650ms" } : {}) }}>
              <span className="size-2.5 rounded-full bg-accent ring-2 ring-surface" />
            </span>
          )}
          {cur && (
            <div
              className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-control border border-line bg-raised px-2.5 py-1.5 text-[12px] shadow-[var(--shadow-pop)]"
              style={x(cur.t) > 55 ? { right: `calc(${100 - x(cur.t)}% + 10px)` } : { left: `calc(${x(cur.t)}% + 10px)` }}
            >
              <div className="num text-ink-4">{monthDayTime(new Date(cur.t).toISOString())}</div>
              <div className="text-ink-2">
                热度 <b className="num font-semibold text-ink">{cur.p!.heat.toFixed(1)}</b>
                <span className="mx-1 text-ink-4">·</span>
                <span className="num">{cur.p!.participants}</span> 位参与者
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
              className={`num absolute whitespace-nowrap text-[11px] leading-none text-ink-4 ${left < 6 ? "" : left > 94 ? "-translate-x-full" : "-translate-x-1/2"} ${wide ? "max-sm:hidden" : ""}`}
              style={{ left: `${left}%` }}
            >
              {label}
            </span>
          );
        })}
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-ink-4">
        趋势仅比较持续完整观测到的相同主体，范围可能小于当前热度统计。移动指针或点击图表查看每小时热度；键盘可用左右方向键切换。
      </p>
    </div>
  );
}
