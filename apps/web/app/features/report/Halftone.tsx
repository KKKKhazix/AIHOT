// The date in the masthead's 报眼 as a signal board: text drawn on a canvas as a halftone of dots, the
// accent part in the brand teal and the rest in ink, over a faint grid of unlit dots and the text's own
// faint silhouette. The dot texture comes from `seed` (the issue), so every
// issue's board differs. Dots print in from the left on load and light up under the pointer; reduced
// motion gets the still board.
// The real text stays in the page (for search, screen readers and before the script runs); the canvas
// covers it once drawn. Mark the accent part of `children` with data-accent.
import { useEffect, useRef, useState, type ReactNode } from "react";

interface Dot {
  x: number;
  y: number;
  r: number;
  /** 0 ink, 1 accent. */
  c: 0 | 1;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [0, 1] on a seeded lattice. */
function valueNoise(seed: number) {
  const rnd = mulberry32(seed);
  const size = 64;
  const grid = Float32Array.from({ length: size * size }, () => rnd());
  const at = (ix: number, iy: number) => grid[(((iy % size) + size) % size) * size + (((ix % size) + size) % size)]!;
  return (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy);
    const b = at(ix + 1, iy);
    const c = at(ix, iy + 1);
    const d = at(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

const TAU = Math.PI * 2;
const INTRO_MS = 950;
const easeOutBack = (p: number) => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2;

export function Halftone({ seed, className = "", children }: { seed: string; className?: string; children: ReactNode }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const label = textRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!host || !label || !canvas || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hover = matchMedia("(hover: hover) and (pointer: fine)").matches;
    const noise = valueNoise(hashSeed(seed));
    const phase = mulberry32(hashSeed(seed) ^ 0x9e3779b9);
    const phaseX = phase();
    const phaseY = phase();

    let lit: Dot[] = [];
    // The glyphs as laid out, for the faint solid silhouette under the dots.
    let glyphs: Array<{ ch: string; font: string; x: number; y: number; accent: boolean }> = [];
    let tint: HTMLCanvasElement | null = null;
    let idle: Array<{ x: number; y: number; r: number }> = [];
    let width = 0;
    let height = 0;
    let pad = 0;
    let reach = 60;
    let colors = { ink: "#000", accent: "#000", idle: "#ccc" };
    let started = 0;
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    let disposed = false;

    // The silhouette: the title itself in its own colours, drawn faintly under the dots.
    const paintTint = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      tint = document.createElement("canvas");
      tint.width = canvas.width;
      tint.height = canvas.height;
      const t = tint.getContext("2d");
      if (!t) return;
      t.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);
      t.textBaseline = "alphabetic";
      for (const g of glyphs) {
        t.font = g.font;
        t.fillStyle = g.accent ? colors.accent : colors.ink;
        t.fillText(g.ch, g.x, g.y);
      }
    };

    const readColors = () => {
      const accentEl = label.querySelector<HTMLElement>("[data-accent]");
      const root = getComputedStyle(document.documentElement);
      colors = {
        ink: getComputedStyle(label).color,
        accent: accentEl ? getComputedStyle(accentEl).color : getComputedStyle(label).color,
        idle: root.getPropertyValue("--line").trim() || "#ddd",
      };
    };

    // Lay the title out as a mask from the heading's own glyph boxes, then sample it on a grid. The
    // canvas reaches a little past the heading on every side (glyphs outgrow a tight line height);
    // drawing stays in the heading's coordinates.
    const layout = () => {
      const box = host.getBoundingClientRect();
      width = box.width;
      height = box.height;
      if (width === 0 || height === 0) return false;
      pad = Math.ceil(parseFloat(getComputedStyle(label).fontSize) * 0.25);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      Object.assign(canvas.style, { left: `${-pad}px`, top: `${-pad}px`, width: `${width + 2 * pad}px`, height: `${height + 2 * pad}px` });
      canvas.width = Math.round((width + 2 * pad) * dpr);
      canvas.height = Math.round((height + 2 * pad) * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);

      const S = 2;
      const mask = document.createElement("canvas");
      mask.width = Math.ceil((width + 2 * pad) * S);
      mask.height = Math.ceil((height + 2 * pad) * S);
      const m = mask.getContext("2d", { willReadFrequently: true });
      if (!m) return false;
      m.setTransform(S, 0, 0, S, pad * S, pad * S);
      m.textBaseline = "alphabetic";
      const range = document.createRange();
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      let fontSize = 0;
      glyphs = [];
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement!;
        const style = getComputedStyle(el);
        const accent = !!el.closest("[data-accent]");
        m.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        m.fillStyle = accent ? "#f00" : "#00f";
        fontSize = Math.max(fontSize, parseFloat(style.fontSize));
        const text = node.textContent ?? "";
        for (let i = 0; i < text.length; i++) {
          const ch = text[i]!;
          if (!ch.trim()) continue;
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          const metrics = m.measureText(ch);
          const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent * 1.1;
          m.fillText(ch, r.left - box.left, r.top - box.top + ascent);
          glyphs.push({ ch, font: m.font, x: r.left - box.left, y: r.top - box.top + ascent, accent });
          x0 = Math.min(x0, r.left - box.left);
          x1 = Math.max(x1, r.right - box.left);
          y0 = Math.min(y0, r.top - box.top);
          y1 = Math.max(y1, r.bottom - box.top);
        }
      }
      if (!fontSize) return false;

      const data = m.getImageData(0, 0, mask.width, mask.height).data;
      const W = mask.width;
      const H = mask.height;
      // A halftone screen: rows offset by half a cell (hexagonal packing), dots that never touch.
      const cell = Math.max(2.2, fontSize / 24);
      const row = cell * 0.866;
      const scale = cell * 5;
      reach = fontSize * 0.55;
      lit = [];
      idle = [];
      const taps = [0.2, 0.5, 0.8];
      let rowIndex = 0;
      for (let y = y0 - cell + phaseY * row; y < y1 + cell; y += row, rowIndex++) {
        const shift = rowIndex % 2 ? cell / 2 : 0;
        for (let x = x0 - cell + phaseX * cell + shift; x < x1 + cell; x += cell) {
          let cover = 0;
          let red = 0;
          let blue = 0;
          for (const ty of taps) {
            for (const tx of taps) {
              const px = Math.floor((x + pad + tx * cell) * S);
              const py = Math.floor((y + pad + ty * cell) * S);
              if (px < 0 || py < 0 || px >= W || py >= H) continue;
              const k = (py * W + px) * 4;
              const a = data[k + 3]! / 255;
              cover += a;
              red += data[k]! * a;
              blue += data[k + 2]! * a;
            }
          }
          cover /= taps.length * taps.length;
          const cx = x + cell / 2;
          const cy = y + cell / 2;
          if (cover > 0.08) {
            const texture = 0.84 + 0.16 * noise(cx / scale, cy / scale);
            lit.push({ x: cx, y: cy, r: cell * 0.47 * Math.sqrt(Math.min(1, cover)) * texture, c: red > blue ? 1 : 0 });
          } else {
            idle.push({ x: cx, y: cy, r: cell * 0.12 });
          }
        }
      }
      return true;
    };

    const draw = (now: number) => {
      frame = 0;
      if (disposed) return;
      const t = still ? 1 : Math.min(1, (now - started) / INTRO_MS);
      ctx.clearRect(-pad, -pad, width + 2 * pad, height + 2 * pad);
      if (tint) {
        ctx.globalAlpha = 0.12 * t;
        ctx.drawImage(tint, -pad, -pad, width + 2 * pad, height + 2 * pad);
        ctx.globalAlpha = 1;
      }
      const near = (x: number, y: number) => (pointer ? Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / reach) : 0);

      // Unlit dots, and the ones the pointer lights up.
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.idle;
      ctx.beginPath();
      for (const d of idle) {
        ctx.moveTo(d.x + d.r, d.y);
        ctx.arc(d.x, d.y, d.r, 0, TAU);
      }
      ctx.fill();
      if (pointer) {
        ctx.fillStyle = colors.accent;
        for (const d of idle) {
          const k = near(d.x, d.y);
          if (k <= 0) continue;
          ctx.globalAlpha = 0.55 * k;
          ctx.beginPath();
          ctx.arc(d.x, d.y, d.r * (1 + 2.2 * k), 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Lit dots print in from the left, then swell under the pointer.
      for (const c of [0, 1] as const) {
        ctx.fillStyle = c ? colors.accent : colors.ink;
        ctx.beginPath();
        for (const d of lit) {
          if (d.c !== c) continue;
          const p = Math.min(1, Math.max(0, (t * 1.5 - (d.x / width) * 0.5) / 0.9));
          if (p <= 0) continue;
          const k = near(d.x, d.y);
          const r = d.r * easeOutBack(p) * (1 + 0.55 * k * k);
          ctx.moveTo(d.x + r, d.y);
          ctx.arc(d.x, d.y, r, 0, TAU);
        }
        ctx.fill();
      }
      if (t < 1) frame = requestAnimationFrame(draw);
    };

    const redraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const rebuild = () => {
      if (!layout()) return;
      readColors();
      paintTint();
      redraw();
    };

    const onMove = (e: PointerEvent) => {
      const box = host.getBoundingClientRect();
      pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
      redraw();
    };
    const onLeave = () => {
      pointer = null;
      redraw();
    };

    const resize = new ResizeObserver(() => rebuild());
    const recolour = () => {
      readColors();
      paintTint();
      redraw();
    };
    const theme = new MutationObserver((changes) => {
      if (changes.some((change) => change.attributeName === "data-font")) rebuild();
      else recolour();
    });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = recolour;

    document.fonts.ready.then(() => {
      if (disposed || !layout()) return;
      readColors();
      paintTint();
      started = performance.now();
      setDrawn(true);
      redraw();
      resize.observe(host);
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font", "class"] });
      scheme.addEventListener("change", onScheme);
      if (hover && !still) {
        canvas.addEventListener("pointermove", onMove);
        canvas.addEventListener("pointerleave", onLeave);
      }
    });

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      scheme.removeEventListener("change", onScheme);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [seed]);

  return (
    <span ref={hostRef} className={`relative inline-block ${className}`}>
      <span ref={textRef} className={`transition-opacity duration-300 ${drawn ? "opacity-0" : ""}`}>
        {children}
      </span>
      <canvas ref={canvasRef} aria-hidden="true" className={`absolute left-0 top-0 size-0 transition-opacity duration-300 ${drawn ? "opacity-100" : "opacity-0"}`} />
    </span>
  );
}
