// The about page's river. Every line is one of the site's real sources (hover names it). Lines run in
// from the left, gather into bundles (many reports of one story), meet the 精选 gate that lets a few
// bundles through, and the ones that pass turn teal and run into a small newspaper: the day's report.
// Pulses carry items along the lines; most stop at the gate, and each that reaches the paper calls
// onArrive (the page brings up the next latest 精选). The four stages line up with the columns under
// the canvas, and `focus` lights one of them. On first sight the river flows in from the left once.
// Theme-aware, paused off screen; reduced motion draws it still. The canvas only illustrates: what it
// says is also written in the page.
import { useEffect, useRef, type ReactNode } from "react";
import { withSubject } from "@aihot/industry/site";

export interface RiverSource {
  name: string;
  kind: string;
  heatOnly: boolean;
}

/** Stage boundaries as fractions of the width: 采集 | 归并 | 精选 | 成刊. */
export const STAGES = [0, 0.25, 0.5, 0.75, 1] as const;

const STEP = 3;
const KIND: Record<string, string> = { x_search: "X 账号", rss: "RSS", web_list: "网页", mp_account: "公众号", json_list: "接口" };
const FLASH_MS = 900;
const INTRO_MS = 1800;
/** Slow in, slow out: the river starts gently, crosses, and settles. */
const easeInOut = (u: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;

type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Strand {
  /** y at x = i * STEP. */
  ys: Float32Array;
  end: number;
  bundle: number;
  /** Items on this line can reach the paper (a kept bundle, and a source that is not heat-only). */
  pass: boolean;
  source: RiverSource | null;
}

interface Bundle {
  y: number;
  n: number;
  kept: boolean;
  half: number;
}

interface Layout {
  w: number;
  h: number;
  strands: Strand[];
  bundles: Bundle[];
  x1: number;
  x2: number;
  gate: number;
  xo: number;
  out: number;
  paper: { x: number; y: number; w: number; h: number };
}

function layout(w: number, h: number, sources: RiverSource[]): Layout {
  const rand = prng(20260928 + sources.length);
  const n = Math.max(40, Math.min(160, Math.round(w / 7.5)));
  const B = w >= 900 ? 9 : w >= 560 ? 7 : 5;
  const K = B >= 9 ? 3 : 2;
  const kept = new Set(Array.from({ length: K }, (_, k) => Math.round(((k + 0.5) * B) / K - 0.5)));
  const pad = Math.max(14, h * 0.07);
  const x1 = w * STAGES[1];
  const x2 = w * STAGES[2];
  const gate = w * 0.625;
  const xo = w * 0.8;
  // The paper sits a little above the middle; the page sets the latest 精选 under it (42% + 42px).
  const out = h * 0.42;
  const pw = Math.max(26, Math.min(46, w * 0.042));
  const ph = pw * 1.32;
  const paper = { x: w * 0.875 - pw / 2, y: out - ph / 2, w: pw, h: ph };

  // A few big stories and more small ones; every bundle has at least two reports.
  const weights = Array.from({ length: B }, () => 0.45 + rand() ** 1.6 * 1.9);
  const total = weights.reduce((a, b) => a + b, 0);
  const sizes = weights.map((x) => Math.max(2, Math.round((x / total) * n)));
  let diff = n - sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % B) {
    if (diff > 0) {
      sizes[i]!++;
      diff--;
    } else if (sizes[i]! > 2) {
      sizes[i]!--;
      diff++;
    }
  }
  const spacing = Math.max(0.8, Math.min(1.6, (h * 0.075) / Math.max(...sizes)));
  const bundles: Bundle[] = sizes.map((size, j) => ({ y: h * 0.14 + ((j + 0.5) / B) * h * 0.72, n: size, kept: kept.has(j), half: (size * spacing) / 2 }));

  const cols = Math.ceil(w / STEP) + 1;
  const strands: Strand[] = [];
  let i = 0;
  sizes.forEach((size, j) => {
    const b = bundles[j]!;
    const mean = pad + ((i + size / 2) / n) * (h - 2 * pad);
    for (let r = 0; r < size; r++, i++) {
      const y0 = pad + ((i + 0.5) / n) * (h - 2 * pad) + (rand() - 0.5) * ((h - 2 * pad) / n) * 0.8;
      const amp = 2 + rand() * 5;
      const freq = (Math.PI * 2) / (70 + rand() * 140);
      const phase = rand() * Math.PI * 2;
      const off = (r - (size - 1) / 2) * spacing;
      const yA = y0 + (mean - y0) * 0.25 + amp * 0.4 * Math.sin(freq * x1 + phase);
      const ys = new Float32Array(cols);
      for (let c = 0; c < cols; c++) {
        const x = c * STEP;
        if (x <= x1) {
          const u = x / x1;
          ys[c] = y0 + (mean - y0) * 0.25 * smooth(u) + amp * (1 - 0.6 * u) * Math.sin(freq * x + phase);
        } else if (x <= x2) ys[c] = yA + (b.y + off - yA) * smooth((x - x1) / (x2 - x1));
        else if (!b.kept || x <= gate) ys[c] = b.y + off;
        else if (x <= xo) ys[c] = b.y + off + (out + off * 0.5 - b.y - off) * smooth((x - gate) / (xo - gate));
        else ys[c] = out + off * 0.5;
      }
      const source = sources.length > 0 ? sources[i % sources.length]! : null;
      strands.push({ ys, end: b.kept ? paper.x : gate + w * 0.045, bundle: j, pass: b.kept && !source?.heatOnly, source });
    }
  });
  return { w, h, strands, bundles, x1, x2, gate, xo, out, paper };
}

function trace(ctx: CanvasRenderingContext2D, s: Strand, from: number, to: number) {
  const a = Math.max(0, Math.floor(from / STEP));
  const b = Math.min(s.ys.length - 1, Math.ceil(to / STEP));
  ctx.beginPath();
  ctx.moveTo(Math.max(from, 0), s.ys[a]!);
  for (let c = a + 1; c <= b; c++) ctx.lineTo(Math.min(c * STEP, to), s.ys[c]!);
}

interface Colors {
  ink: RGB;
  accent: RGB;
  line: RGB;
  surface: RGB;
  bg: RGB;
  dark: boolean;
}

function readColors(probe: CanvasRenderingContext2D): Colors {
  const root = getComputedStyle(document.documentElement);
  const parse = (css: string, fallback: RGB): RGB => {
    if (!css) return fallback;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = `rgb(${fallback.join(",")})`;
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  };
  const bg = parse(getComputedStyle(document.body).backgroundColor, [250, 249, 246]);
  return {
    ink: parse(root.getPropertyValue("--ink").trim(), [32, 42, 48]),
    accent: parse(root.getPropertyValue("--accent").trim(), [23, 107, 117]),
    line: parse(root.getPropertyValue("--line-strong").trim(), [200, 205, 205]),
    surface: parse(root.getPropertyValue("--surface").trim(), [255, 255, 255]),
    bg,
    dark: bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11 < 110,
  };
}

function paintStatic(ctx: CanvasRenderingContext2D, L: Layout, col: Colors) {
  const base = col.dark ? 0.2 : 0.13;
  ctx.clearRect(0, 0, L.w, L.h);
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  for (const s of L.strands) {
    const kept = L.bundles[s.bundle]!.kept;
    trace(ctx, s, 0, Math.min(s.end, L.gate));
    ctx.strokeStyle = rgba(col.ink, base);
    ctx.stroke();
    trace(ctx, s, L.gate, s.end);
    if (kept) ctx.strokeStyle = rgba(col.accent, col.dark ? 0.6 : 0.45);
    else {
      const g = ctx.createLinearGradient(L.gate, 0, s.end, 0);
      g.addColorStop(0, rgba(col.ink, base));
      g.addColorStop(1, rgba(col.ink, 0));
      ctx.strokeStyle = g;
    }
    ctx.stroke();
  }
  // The cable into the paper.
  ctx.beginPath();
  ctx.moveTo(L.xo, L.out);
  ctx.lineTo(L.paper.x, L.out);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = rgba(col.accent, 0.95);
  ctx.stroke();

  // The gate: a hairline across the river, open only where a kept bundle passes.
  const top = L.h * 0.05;
  const bottom = L.h * 0.95;
  const gaps = L.bundles.filter((b) => b.kept).map((b) => [b.y - b.half - 7, b.y + b.half + 7] as const);
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(col.line, 1);
  ctx.beginPath();
  let y = top;
  for (const [a, b] of gaps) {
    ctx.moveTo(L.gate, y);
    ctx.lineTo(L.gate, a);
    y = b;
  }
  ctx.moveTo(L.gate, y);
  ctx.lineTo(L.gate, bottom);
  ctx.stroke();
  for (const [a, b] of gaps) {
    for (const yy of [a, b]) {
      ctx.beginPath();
      ctx.moveTo(L.gate - 4, yy);
      ctx.lineTo(L.gate + 4, yy);
      ctx.stroke();
    }
  }

  paintPaper(ctx, L, col, 0);

  // The lines come in from beyond the left edge.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const fade = ctx.createLinearGradient(0, 0, Math.min(64, L.w * 0.06), 0);
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, Math.min(64, L.w * 0.06), L.h);
  ctx.restore();
}

/** The day's paper: a nameplate bar, the headline and two columns of rules. `glow` lights it. */
function paintPaper(ctx: CanvasRenderingContext2D, L: Layout, col: Colors, glow: number) {
  const p = L.paper;
  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = rgba(col.accent, 0.55 * glow);
    ctx.shadowBlur = 18 * glow;
  }
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(p.x, p.y, p.w, p.h, 5);
  else ctx.rect(p.x, p.y, p.w, p.h);
  ctx.fillStyle = rgba(col.surface, 1);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = glow > 0 ? rgba(col.accent, 0.35 + 0.65 * glow) : rgba(col.line, 1);
  ctx.stroke();
  ctx.restore();
  const ix = p.x + p.w * 0.17;
  const iw = p.w * 0.66;
  ctx.fillStyle = rgba(col.accent, 1);
  ctx.fillRect(ix, p.y + p.h * 0.13, iw * 0.42, Math.max(2, p.w * 0.06));
  ctx.fillStyle = glow > 0 ? rgba(col.accent, 0.5 + 0.5 * glow) : rgba(col.ink, 0.82);
  ctx.fillRect(ix, p.y + p.h * 0.29, iw * 0.9, Math.max(2, p.w * 0.075));
  ctx.fillStyle = rgba(col.ink, col.dark ? 0.4 : 0.26);
  for (let r = 0; r < 4; r++) {
    const yy = p.y + p.h * (0.47 + r * 0.12);
    ctx.fillRect(ix, yy, iw * 0.45, 1);
    ctx.fillRect(ix + iw * 0.55, yy, iw * 0.45, 1);
  }
}

interface Pulse {
  s: number;
  x: number;
  v: number;
}

export function SignalRiver({
  sources,
  focus,
  onArrive,
  className = "",
  children,
}: {
  sources: RiverSource[];
  focus: number | null;
  onArrive?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef(focus);
  const arriveRef = useRef(onArrive);
  const redrawRef = useRef<() => void>(() => {});
  arriveRef.current = onArrive;

  useEffect(() => {
    focusRef.current = focus;
    redrawRef.current();
  }, [focus]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const label = labelRef.current;
    const ctx = canvas?.getContext("2d");
    if (!wrap || !canvas || !label || !ctx) return;
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const layer = document.createElement("canvas");
    const lctx = layer.getContext("2d")!;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

    let L: Layout | null = null;
    let col = readColors(probe);
    let dpr = 1;
    let pulses: Pulse[] = [];
    let passing: number[] = [];
    let spawnDebt = 0;
    let flashAt = -Infinity;
    let hover: { s: number | null; bundle: number | null; paper: boolean } | null = null;
    let frame = 0;
    let last = 0;
    // The intro starts the first time the river is seen.
    let introAt = still ? -Infinity : 0;
    // On screen now (the observer keeps it current after), so the intro plays where it is seen.
    const box = wrap.getBoundingClientRect();
    let visible = box.bottom > 0 && box.top < window.innerHeight;
    let disposed = false;

    const build = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w < 10 || h < 10) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const c of [canvas, layer]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      L = layout(w, h, sources);
      passing = L.strands.flatMap((s, i) => (s.pass ? [i] : []));
      pulses = [];
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintStatic(lctx, L, col);
    };

    const draw = (now: number) => {
      if (!L) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const reveal = introAt === 0 ? 0 : easeInOut((now - introAt) / INTRO_MS);
      if (reveal < 1) {
        // The river flows in: the drawing is uncovered left to right behind a soft edge.
        const edge = (L.w + 80) * reveal;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, Math.max(0, edge) * dpr, canvas.height);
        ctx.clip();
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const soft = ctx.createLinearGradient(edge - 80, 0, edge, 0);
        soft.addColorStop(0, rgba(col.bg, 0));
        soft.addColorStop(1, rgba(col.bg, 1));
        ctx.fillStyle = soft;
        ctx.fillRect(edge - 80, 0, 80, L.h);
        return;
      }
      ctx.drawImage(layer, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      if (hover && (hover.s !== null || hover.bundle !== null)) {
        const lit = hover.bundle !== null ? L.strands.filter((s) => s.bundle === hover!.bundle) : [L.strands[hover.s!]!];
        ctx.lineWidth = lit.length > 1 ? 1 : 1.5;
        for (const s of lit) {
          const kept = L.bundles[s.bundle]!.kept;
          trace(ctx, s, 0, Math.min(s.end, L.gate));
          ctx.strokeStyle = rgba(col.ink, lit.length > 1 ? 0.45 : 0.9);
          ctx.stroke();
          trace(ctx, s, L.gate, s.end);
          ctx.strokeStyle = kept ? rgba(col.accent, 0.95) : rgba(col.ink, lit.length > 1 ? 0.3 : 0.6);
          ctx.stroke();
        }
      }

      const trail = Math.max(24, Math.min(56, L.w * 0.04));
      ctx.lineWidth = 1.8;
      for (const p of pulses) {
        const s = L.strands[p.s]!;
        const head = Math.min(p.x, s.end);
        if (head <= 0) continue;
        const tail = Math.max(0, head - trail);
        let c = col.ink;
        let a = col.dark ? 0.85 : 0.7;
        if (head >= L.gate) {
          if (s.pass) {
            c = col.accent;
            a = 1;
          } else a *= Math.max(0, 1 - (head - L.gate) / (s.end - L.gate));
        }
        if (a <= 0.01) continue;
        const g = ctx.createLinearGradient(tail, 0, head, 0);
        g.addColorStop(0, rgba(c, 0));
        g.addColorStop(1, rgba(c, a));
        trace(ctx, s, tail, head);
        ctx.strokeStyle = g;
        ctx.stroke();
      }

      const f = (now - flashAt) / FLASH_MS;
      if (f >= 0 && f < 1) paintPaper(ctx, L, col, 1 - f);

      const fx = focusRef.current;
      if (fx !== null && fx !== undefined) {
        ctx.fillStyle = rgba(col.bg, 0.62);
        for (let k = 0; k < 4; k++) if (k !== fx) ctx.fillRect(L.w * STAGES[k]!, 0, L.w * (STAGES[k + 1]! - STAGES[k]!), L.h);
      }
    };

    const tick = (now: number) => {
      frame = 0;
      if (disposed || !L) return;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
      last = now;
      if (!introAt) introAt = now;
      if (now - introAt < INTRO_MS * 0.8) {
        draw(now);
        schedule();
        return;
      }
      spawnDebt += dt * (L.w >= 900 ? 7 : 4.5);
      while (spawnDebt >= 1 && pulses.length < 80) {
        spawnDebt -= 1;
        const s = passing.length > 0 && Math.random() < 0.11 ? passing[Math.floor(Math.random() * passing.length)]! : Math.floor(Math.random() * L.strands.length);
        pulses.push({ s, x: -Math.random() * 30, v: L.w * (0.12 + Math.random() * 0.06) });
      }
      const kept: Pulse[] = [];
      for (const p of pulses) {
        p.x += p.v * dt;
        const s = L.strands[p.s]!;
        if (p.x < s.end) kept.push(p);
        else if (s.pass) {
          flashAt = now;
          arriveRef.current?.();
        }
      }
      pulses = kept;
      draw(now);
      schedule();
    };

    const schedule = () => {
      if (!frame && !still && visible && !document.hidden && !disposed) frame = requestAnimationFrame(tick);
    };
    const redraw = () => {
      if (still || !frame) draw(performance.now());
    };
    redrawRef.current = redraw;

    const place = (x: number, y: number, title: string, note: string) => {
      const [t, n] = label.children as unknown as [HTMLElement, HTMLElement];
      t.textContent = title;
      n.textContent = note;
      n.hidden = !note;
      label.hidden = false;
      const w = label.offsetWidth;
      const left = Math.min(Math.max(8, x + 14), wrap.clientWidth - w - 8);
      const top = Math.max(8, y + 16);
      label.style.transform = `translate(${left}px, ${top}px)`;
    };

    const onMove = (e: PointerEvent) => {
      if (!L) return;
      const box = wrap.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      const p = L.paper;
      if (x >= p.x - 8 && x <= p.x + p.w + 8 && y >= p.y - 8 && y <= p.y + p.h + 8) {
        hover = { s: null, bundle: null, paper: true };
        place(x, y, withSubject("日报"), "每天 08:00 出刊");
        redraw();
        return;
      }
      const c = Math.round(x / STEP);
      let best = -1;
      let dist = 7;
      L.strands.forEach((s, i) => {
        if (x > s.end + 2) return;
        const d = Math.abs(s.ys[Math.min(c, s.ys.length - 1)]! - y);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      if (best < 0) {
        onLeave();
        return;
      }
      const s = L.strands[best]!;
      const b = L.bundles[s.bundle]!;
      if (x < L.x2) {
        hover = { s: best, bundle: null, paper: false };
        const kind = s.source ? (KIND[s.source.kind] ?? "信源") : "信源";
        place(x, y, s.source ? s.source.name : "一个信源", s.source?.heatOnly ? `${kind} · 只计入热度` : kind);
      } else {
        hover = { s: null, bundle: s.bundle, paper: false };
        if (x < L.gate) place(x, y, "同一件事", `${b.n} 个来源的报道合成一条`);
        else if (b.kept) place(x, y, "进了精选", "有信息量，分数也够");
        else place(x, y, "没进精选", "信息不够、重复或只是营销");
      }
      redraw();
    };
    const onLeave = () => {
      hover = null;
      label.hidden = true;
      redraw();
    };

    const resize = new ResizeObserver(() => {
      build();
      redraw();
    });
    const recolour = () => {
      col = readColors(probe);
      if (L) paintStatic(lctx, L, col);
      redraw();
    };
    const theme = new MutationObserver(recolour);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const seen = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      last = 0;
      schedule();
    });
    const onVisibility = () => {
      last = 0;
      schedule();
    };

    build();
    draw(performance.now());
    schedule();
    resize.observe(wrap);
    seen.observe(wrap);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    scheme.addEventListener("change", recolour);
    document.addEventListener("visibilitychange", onVisibility);
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      redrawRef.current = () => {};
      resize.disconnect();
      seen.disconnect();
      theme.disconnect();
      scheme.removeEventListener("change", recolour);
      document.removeEventListener("visibilitychange", onVisibility);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
    };
  }, [sources]);

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 size-full" />
      <div ref={labelRef} hidden className="pointer-events-none absolute left-0 top-0 z-10 max-w-[240px] rounded-control bg-surface px-2.5 py-1.5 shadow-[0_6px_20px_rgba(0,0,0,0.08)] ring-1 ring-line">
        <div className="truncate text-[12.5px] font-semibold text-ink" />
        <div className="mt-0.5 truncate text-[11.5px] text-ink-4" />
      </div>
      {children}
    </div>
  );
}
