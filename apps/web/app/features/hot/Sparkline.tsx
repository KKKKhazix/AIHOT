import { useId } from "react";
import { areaPath, curvePath, observedRuns, type Pt } from "./curve";

// The small 24-hour heat curve beside a hot-list entry, over a wash of its colour that fades to the
// baseline, ending in a dot for now. Hours without a comparable snapshot break the curve rather than
// being drawn as zero; with fewer than three observed hours nothing is drawn. The curve fills whatever
// box the class gives it: strokes and the dot keep their size however the box stretches.
export function Sparkline({ values, className = "h-6 w-[88px]" }: { values: Array<number | null>; className?: string }) {
  // A plain id for url(#…); React’s generated ids carry punctuation.
  const id = `spark${useId().replace(/[^\w-]/g, "")}`;
  const W = 100;
  const H = 100;
  const seen = values.filter((v): v is number => v !== null);
  if (seen.length < 3) return <span className={`block ${className}`} aria-hidden="true" />;
  // Scaled from zero, so a small wobble on a steady story stays a small wobble.
  const max = Math.max(...seen) || 1;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * W;
  const y = (v: number) => (1 - v / max) * H;
  const runs = observedRuns(values).map((run) => run.map((i): Pt => [x(i), y(values[i]!)]));
  const end = runs[runs.length - 1]!.at(-1)!;
  const dot = `M${end[0]} ${end[1]}h0`;
  const gaps = seen.length < values.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`overflow-visible text-accent ${className}`} role="img" aria-label={`近 24 小时热度走势${gaps ? "，部分时段缺少可比数据" : ""}`}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.2" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {runs.map((pts) => (
        <path key={`a${pts[0]![0]}`} d={areaPath(pts, H)} fill={`url(#${id})`} />
      ))}
      {runs.map((pts) => (
        <path key={`l${pts[0]![0]}`} d={curvePath(pts)} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
      <path d={dot} stroke="currentColor" strokeOpacity="0.18" strokeWidth="11" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <path d={dot} stroke="var(--surface)" strokeWidth="6.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <path d={dot} stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
