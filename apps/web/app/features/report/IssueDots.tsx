// The dot grid in the masthead's 报眼, beside the date: one dot per day of the month (dailies), week
// of the year (weeklies) or month (monthlies). Issues that exist are ink dots, this issue is a larger
// teal dot in a ring, the rest are faint. Hover names the day and its issue; a click opens it. Drawn
// on a canvas in the same dot language as the nameplate; the archive column is the accessible way
// to the same issues.
import { useEffect, useMemo, useRef } from "react";
import type { ReportNavigationEntry, ReportKind } from "@aihot/contracts/reports";
import { watchAppearance } from "../../lib/local-state";
import { MOTION, easeOutBack, reducedMotion } from "../../lib/motion";
import { KIND_PATH, periodGrid } from "./format";
import { useNavigate } from "../../lib/link";
import { useLocale, useT } from "../../lib/i18n";

const ROW = 20;
const TAU = Math.PI * 2;
const INTRO_MS = 700;

export function IssueDots({ kind, reportKey, issueNumber, index, className = "" }: { kind: ReportKind; reportKey: string; issueNumber: number; index: ReportNavigationEntry[]; className?: string }) {
  const locale = useLocale();
  const t = useT();
  const grid = useMemo(() => periodGrid(kind, reportKey, index, issueNumber, locale), [kind, reportKey, index, issueNumber, locale]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigate = useNavigate();
  const rows = Math.ceil(grid.cells.length / grid.columns);
  // The dots come up once, when the masthead first shows; going on to another issue moves only what changed.
  const introduced = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { cells, columns } = grid;
    const still = reducedMotion();
    const intro = !still && !introduced.current;
    introduced.current = true;
    let width = 0;
    let cw = 0;
    let hovered = -1;
    // The dot under the pointer swells and the ones it has left settle back, each from where it is, at about
    // feedback speed: a pointer sweeping across several dots leaves a soft wake, not jumps.
    const swell = new Float32Array(cells.length);
    let drawnAt = 0;
    let started = 0;
    let frame = 0;
    let disposed = false;
    let colors = { ink: "#000", accent: "#000", idle: "#ccc" };

    const readColors = () => {
      const root = getComputedStyle(document.documentElement);
      colors = {
        ink: root.getPropertyValue("--ink").trim() || "#000",
        accent: root.getPropertyValue("--accent").trim() || "#000",
        idle: root.getPropertyValue("--line-strong").trim() || "#ccc",
      };
    };
    const size = () => {
      width = canvas.clientWidth;
      if (!width) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      cw = width / columns;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(rows * ROW * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = (now: number) => {
      frame = 0;
      if (disposed || !width) return;
      const t = intro ? Math.min(1, (now - started) / INTRO_MS) : 1;
      const step = still ? 1 : 1 - Math.exp(-(drawnAt ? now - drawnAt : 16) / (MOTION.feedback / 3));
      drawnAt = now;
      let settling = false;
      ctx.clearRect(0, 0, width, rows * ROW);
      const unit = Math.min(cw, ROW);
      cells.forEach((c, i) => {
        if (c.state === "pad") return;
        const p = Math.min(1, Math.max(0, t * 1.6 - (i / cells.length) * 0.6));
        if (p <= 0) return;
        const target = i === hovered ? 1 : 0;
        swell[i] = swell[i]! + (target - swell[i]!) * step;
        if (Math.abs(target - swell[i]!) > 0.01) settling = true;
        const grow = easeOutBack(p) * (1 + 0.4 * swell[i]!);
        const x = ((i % columns) + 0.5) * cw;
        const y = (Math.floor(i / columns) + 0.5) * ROW;
        const r = (c.state === "current" ? 0.26 : c.state === "issue" ? 0.17 : 0.08) * unit * grow;
        ctx.fillStyle = c.state === "current" ? colors.accent : c.state === "issue" ? colors.ink : colors.idle;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        if (c.state === "current") {
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, unit * 0.42 * easeOutBack(p), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });
      if (t < 1 || settling) frame = requestAnimationFrame(draw);
      else drawnAt = 0;
    };
    const redraw = () => {
      if (width && !frame) frame = requestAnimationFrame(draw);
    };

    const cellAt = (e: PointerEvent | MouseEvent) => {
      const box = canvas.getBoundingClientRect();
      const col = Math.floor((e.clientX - box.left) / cw);
      const row = Math.floor((e.clientY - box.top) / ROW);
      const i = row * columns + col;
      return col >= 0 && col < columns && i >= 0 && i < cells.length ? i : -1;
    };
    const onMove = (e: PointerEvent) => {
      const i = cellAt(e);
      const c = cells[i];
      const open = !!c && c.state === "issue";
      canvas.style.cursor = open ? "pointer" : "default";
      canvas.title = c && c.state !== "pad" ? c.label : "";
      const next = c && c.state !== "none" && c.state !== "pad" ? i : -1;
      if (next !== hovered) {
        hovered = next;
        redraw();
      }
    };
    const onLeave = () => {
      hovered = -1;
      canvas.title = "";
      redraw();
    };
    const onClick = (e: MouseEvent) => {
      const c = cells[cellAt(e)];
      if (c?.key && c.state === "issue") navigate(`${KIND_PATH[kind]}/${c.key}`);
    };

    const resize = new ResizeObserver(() => {
      size();
      redraw();
    });
    const recolour = () => {
      readColors();
      redraw();
    };

    readColors();
    size();
    started = performance.now();
    redraw();
    resize.observe(canvas);
    const unwatch = watchAppearance((change) => change === "theme" && recolour());
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick);
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      unwatch();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
    };
  }, [grid, rows, kind, navigate]);

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between text-ui-caption-sm text-ink-4">
        <span className={`font-semibold ${t("tracking-[0.2em]", "uppercase tracking-[0.08em]")} text-ink-2`}>{grid.title}</span>
        <span className="num">{grid.note}</span>
      </div>
      {grid.heads && (
        <div className="mt-2 grid text-center text-ui-micro-7 leading-none text-ink-4" style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))` }}>
          {/* By place: the English heads repeat letters (M T W T F S S). */}
          {grid.heads.map((h, i) => (
            <span key={i}>{h}</span>
          ))}
        </div>
      )}
      <canvas ref={canvasRef} aria-hidden="true" className="mt-1 block w-full" style={{ height: rows * ROW }} />
    </div>
  );
}
