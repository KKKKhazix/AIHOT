// Shared canvas plumbing for interactive drawings (About page river, changelog figures): theme-aware RGB palette
// resolved from CSS tokens, easing helpers, HiDPI sizing, viewport/tab-aware animation loop and pointer tracking.
import { watchAppearance } from "./local-state";
import { reducedMotion } from "./motion";

export type RGB = [number, number, number];
export const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
export const easeOut = (u: number) => 1 - (1 - Math.min(1, Math.max(0, u))) ** 3;
export const easeInOut = (u: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;

export interface Palette {
  ink: RGB;
  accent: RGB;
  /** --line-strong laid on the card. */
  line: RGB;
  surface: RGB;
  /** The card under the accent wash (a release's header). */
  wash: RGB;
  /** Page body background colour. */
  bg: RGB;
  dark: boolean;
  font: string;
}

/** Resolves the theme tokens (some translucent) to solid colours through a 1×1 canvas. */
export function readPalette(): Palette {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const token = (name: string) => root.getPropertyValue(name).trim();
  const paint = (...layers: string[]): RGB => {
    ctx.clearRect(0, 0, 1, 1);
    for (const css of layers) {
      if (!css) continue;
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
    }
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  };
  const bg = paint("#faf9f6", body.backgroundColor);
  return {
    ink: paint("#202a30", token("--ink")),
    accent: paint("#176b75", token("--accent")),
    line: paint("#fff", token("--surface"), token("--line-strong")),
    surface: paint("#fff", token("--surface")),
    wash: paint("#fff", token("--surface"), token("--accent-softer")),
    bg,
    dark: document.documentElement.dataset.theme === "dark" || bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11 < 110,
    font: body.fontFamily || "system-ui, sans-serif",
  };
}

export interface Scene {
  /** Lays the drawing out for the box's size (CSS pixels) and the palette; runs again on change. */
  layout(w: number, h: number, p: Palette): void;
  /** Draws the frame at `now` (ms). Returns true while it has more to animate. `still` asks for the final state. */
  draw(ctx: CanvasRenderingContext2D, now: number, still: boolean): boolean;
}

/**
 * Runs `scene` on `canvas`, which covers `box`. `wake` asks for frames again after input changed the
 * scene. Nothing is drawn while the box is off screen, so an intro plays where it is seen.
 */
export function runScene(box: HTMLElement, canvas: HTMLCanvasElement, scene: Scene) {
  const ctx = canvas.getContext("2d")!;
  const still = reducedMotion();
  let palette = readPalette();
  let w = 0;
  let h = 0;
  let dpr = 1;
  let frame = 0;
  let stopped = false;
  const rect = box.getBoundingClientRect();
  let visible = rect.bottom > 0 && rect.top < window.innerHeight;

  const size = () => {
    w = box.clientWidth;
    h = box.clientHeight;
    if (w < 10 || h < 10) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    scene.layout(w, h, palette);
  };
  const tick = (now: number) => {
    frame = 0;
    if (stopped || w < 10 || h < 10) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (scene.draw(ctx, now, still) && !still) wake();
  };
  const wake = () => {
    if (!frame && !stopped && visible && !document.hidden) frame = requestAnimationFrame(tick);
  };
  const recolour = () => {
    palette = readPalette();
    if (w >= 10 && h >= 10) scene.layout(w, h, palette);
    wake();
  };

  const resize = new ResizeObserver(() => {
    size();
    wake();
  });
  const seen = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    wake();
  });
  const unwatch = watchAppearance(recolour);
  document.addEventListener("visibilitychange", wake);
  resize.observe(box);
  seen.observe(box);
  size();
  wake();

  return {
    still,
    wake,
    stop() {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      seen.disconnect();
      unwatch();
      document.removeEventListener("visibilitychange", wake);
    },
  };
}

/** The pointer in the box's coordinates, or null when it leaves. */
export function trackPointer(box: HTMLElement, onChange: (p: { x: number; y: number } | null) => void) {
  const move = (e: PointerEvent) => {
    const r = box.getBoundingClientRect();
    onChange({ x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const leave = () => onChange(null);
  box.addEventListener("pointermove", move);
  box.addEventListener("pointerleave", leave);
  return () => {
    box.removeEventListener("pointermove", move);
    box.removeEventListener("pointerleave", leave);
  };
}
