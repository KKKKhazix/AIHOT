// The site's one motion language (apps/web/app/app.css, "Motion"): every change of state moves on one of its
// curves and lengths. Written by hand, it drifted into a dozen curves and timings, each place deciding again.
import { readFileSync } from "node:fs";
import { sourceFiles, type Violation } from "./source-checks.ts";

const APP_CSS = "apps/web/app/app.css";
const MOTION_TS = "apps/web/app/lib/motion.ts";
const css = readFileSync(new URL("../" + APP_CSS, import.meta.url), "utf8");

/** Every class an `fx-*`, `anim-*` or `animate-*` name can refer to: defined in a stylesheet, or Tailwind's spinner. */
function definedAnimationClasses(): Set<string> {
  const names = new Set(["animate-spin"]);
  for (const file of sourceFiles("apps/web/app", "modules/*/web/**")) {
    if (!file.endsWith(".css")) continue;
    for (const m of readFileSync(new URL("../" + file, import.meta.url), "utf8").matchAll(/\.((?:fx|anim|animate)-[\w-]+)/g)) names.add(m[1]!);
  }
  return names;
}

const RULES: Array<{ test: RegExp; fix: string; css?: boolean; script?: boolean }> = [
  { test: /cubic-bezier\(|\blinear\(\s*0/, fix: "写死了曲线。用 ease-out-quart、ease-drawer 或 ease-spring（样式表用 var(--ease-…)，脚本用 lib/motion.ts 的 MOTION.easeOut / easeDrawer）", css: true, script: true },
  { test: /(?<![\w-])duration-(?:\d|\[)/, fix: "写死了时长。反馈（悬停、按下、换色）不写时长用默认；出现、展开、移动用 duration-(--dur-move)，整块面板用 duration-(--dur-travel)", script: true },
  { test: /(?<![\w-])ease-(?:in|out|in-out|linear|\[)(?![\w-])/, fix: "用 ease-out-quart、ease-drawer 或 ease-spring，不用 Tailwind 默认曲线", script: true },
  { test: /(?<![\w-])transition-\[[^\]]*\btransform\b/, fix: "Tailwind 4 的 translate-*、scale-*、rotate-* 设的是 translate、scale、rotate 属性，不是 transform：列出这几个（transition-[opacity,translate]），或用 transition-transform（四个都含）", script: true },
  { test: /(?<![\w-])transition-all\b/, fix: "transition-all 会把布局属性也带上动起来。写明要过渡的属性（transition-colors、transition-[opacity,translate] 等）", script: true },
  { test: /(?<![\w-])animate-(?:ping|pulse|bounce)\b/, fix: "用站内的动效：加载占位用 .skeleton，正在发生的标记用 .live-dot", script: true },
  { test: /behavior\s*:\s*["'`]smooth/, fix: "平滑滚动要尊重“减少动态效果”：behavior 用 lib/motion.ts 的 scrollBehavior()，跳锚点用 scrollToAnchor()", script: true },
  { test: /easing\s*:\s*["'`]/, fix: "写死了曲线。Web Animations 的 easing 用 lib/motion.ts 的 MOTION.easeOut / easeDrawer", script: true },
  { test: /\btransition(?:-duration)?\s*:[^;{}]*(?<![\w.])(?!0\.01ms)\d*\.?\d+m?s\b/, fix: "过渡时长用 var(--dur-feedback)、var(--dur-move)、var(--dur-travel) 或离场的 var(--dur-leave)、var(--dur-leave-travel)", css: true },
  { test: /\.style\.transition\s*=\s*[`"'][^`"']*\b\d+m?s\b/, fix: "过渡时长用 lib/motion.ts 的 MOTION.*，不写死毫秒", script: true },
  { test: /\btransition\s*:\s*[`"'][^`"']*(?<![\w.-])(?!0m?s\b)\d*\.?\d+m?s\b/, fix: "行内样式的过渡时长用 var(--dur-…)（或 lib/motion.ts 的 MOTION.*），不写死", script: true },
  // A one-shot animation is a change of state like any other; loops that run while something goes on (a live mark,
  // a skeleton, a foil's shimmer) keep their own pace.
  { test: /\banimation(?:-duration)?\s*:(?![^;]*\binfinite\b)[^;]*(?:(?<![\w.-])(?!0\.01ms)\d*\.?\d+m?s\b|(?<![\w-])(?:ease(?:-in-out|-in|-out)?|linear)(?![\w-]))/, fix: "一次性动画的时长和曲线用 var(--dur-…) 和 var(--ease-…)；只有持续循环（infinite）的可以自定节奏", css: true },
];

export function motionViolations() {
  const defined = definedAnimationClasses();
  const result = new Map<string, Violation[]>();
  for (const file of sourceFiles("apps/web", "modules/*/web.*", "modules/*/web/**", "site")) {
    if (!/\.(?:[jt]sx?|css)$/.test(file) || /\/(?:tests?|__tests__|build)\//.test(file)) continue;
    if (file === MOTION_TS) continue;
    const isCss = file.endsWith(".css");
    const withoutComments = readFileSync(new URL("../" + file, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
    const lines = (isCss ? withoutComments : withoutComments.split("\n").map((line) => line.replace(/(^|\s)\/\/.*$/, "")).join("\n")).split("\n");
    const hits: Violation[] = [];
    lines.forEach((text, i) => {
      // Curves and lengths are named where they are defined: app.css's tokens, or a module's own drawing (the
      // binder's page turn) under a custom property of its own.
      if (isCss && /^\s*--[\w-]+\s*:/.test(text)) return;
      for (const rule of RULES) {
        if (isCss ? !rule.css : !rule.script) continue;
        if (rule.test.test(text)) hits.push({ line: i + 1, fix: rule.fix });
      }
      if (!isCss) {
        for (const m of text.matchAll(/(?<![\w-])((?:fx|anim|animate)-[a-z][\w-]*)/g)) {
          if (!defined.has(m[1]!)) hits.push({ line: i + 1, fix: `${m[1]} 没有定义。用 app.css「Motion」里的 fx-*、anim-* 或 animate-fade-up` });
        }
      }
    });
    result.set(file, hits);
  }
  return result;
}

/** The lengths and curves app.css defines, as lib/motion.ts must repeat them for scripts. */
export function cssMotionTokens() {
  const ms = (name: string) => Number(css.match(new RegExp(`--dur-${name}:\\s*(\\d+)ms;`))?.[1]);
  const ease = (name: string) => css.match(new RegExp(`--ease-${name}:\\s*([^;]+);`))?.[1]?.trim();
  return {
    feedback: ms("feedback"), move: ms("move"), travel: ms("travel"), leave: ms("leave"), leaveTravel: ms("leave-travel"),
    easeOut: ease("out-quart"), easeDrawer: ease("drawer"), easeSpring: ease("spring"),
  };
}
