// The phone shell's top bar (below lg). Left: where back leads, or the brand; middle: the page's title
// once its own heading has scrolled up under the bar, or a switch that always shows; right: actions. Tab
// pages also get a large title under the bar. Desktop pages keep their own headers.
import { forwardRef, useEffect, useLayoutEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { IconChevronLeft } from "../icons";
import { historyIndex, previousScreen } from "./screens";
import { markBack } from "./transitions";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface BackTarget {
  /** Where back goes when this page was opened directly (no page of ours behind it). */
  to: string;
  /** What the button says then; otherwise it names the page behind, or reads "返回". */
  label: string;
}

export function PhoneBar({ back, title, large = false, sub, leading, center, actions }: {
  back?: BackTarget;
  /** The page's name. In the bar once the page's heading ([data-page-title]) is under it; with `large`,
   *  also as the large heading below the bar. */
  title?: ReactNode;
  large?: boolean;
  /** A line under the large title. */
  sub?: ReactNode;
  leading?: ReactNode;
  /** Always shown in the middle instead of the title (精选 | 全部). */
  center?: ReactNode;
  actions?: ReactNode;
}) {
  const scrolled = useScrolled();
  const titleShown = useHeadingUnderBar(!center && !!title);
  const wideCenter = !!center && !back && !leading;
  return (
    <>
      <header
        data-phone-bar=""
        className={`bleed sticky top-0 z-40 bg-bg/85 backdrop-blur-xl backdrop-saturate-150 transition-shadow duration-200 lg:hidden ${scrolled ? "shadow-[0_1px_0_var(--line-soft)]" : ""}`}
      >
        <div className={`-mx-2.5 grid h-[var(--bar-h)] items-center ${wideCenter ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"}`}>
          {!wideCenter && <div className="flex min-w-0 items-center">{back ? <BackButton {...back} /> : leading}</div>}
          <div className={`flex min-w-0 justify-center ${wideCenter ? "" : "max-w-[calc(100vw-184px)]"}`}>
            {center ?? (
              title && (
                <span
                  aria-hidden={!titleShown}
                  className={`truncate text-[15.5px] font-semibold text-ink transition-[opacity,transform] duration-200 ${titleShown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"}`}
                >
                  {title}
                </span>
              )
            )}
          </div>
          <div className="flex min-w-0 items-center justify-end">{actions}</div>
        </div>
      </header>
      {large && title && (
        <div className="pb-3 pt-0.5 lg:hidden">
          <h1 data-page-title="" className="text-[30px] font-bold leading-[1.25] tracking-[-0.01em] text-ink">
            {title}
          </h1>
          {sub && <div className="mt-1 text-[12.5px] leading-relaxed text-ink-4">{sub}</div>}
        </div>
      )}
    </>
  );
}

/** "‹ 精选": back through the reader's history, or to the page's parent when it was opened directly. */
function BackButton({ to, label }: BackTarget) {
  const navigate = useNavigate();
  const { key } = useLocation();
  const [text, setText] = useState(label);
  useIsoLayoutEffect(() => {
    if (historyIndex() === 0) return setText(label);
    const behind = previousScreen();
    setText(behind ? behind : "返回");
  }, [key, label]);
  return (
    <button
      type="button"
      onClick={() => {
        markBack();
        if (historyIndex() > 0) navigate(-1);
        else navigate(to, { viewTransition: true });
      }}
      className="flex h-11 min-w-11 items-center pl-1 pr-2 text-[16px] text-accent transition-opacity active:opacity-50"
    >
      <IconChevronLeft size={25} strokeWidth={2.1} />
      <span className="max-w-[7em] truncate">{text}</span>
    </button>
  );
}

/** A 44px round icon button for the bar; `on` tints it (a filter in use). */
export const BarButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; on?: boolean; children: ReactNode }>(function BarButton(
  { label, on = false, children, className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={`relative grid size-11 shrink-0 place-items-center rounded-full transition-colors active:bg-bg-sunk ${on ? "text-accent" : "text-ink-2"} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(window.scrollY > 4);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return scrolled;
}

/**
 * True once the page's visible heading ([data-page-title]) has gone up under the bar. Without such a
 * heading the bar shows the title at once.
 */
function useHeadingUnderBar(enabled: boolean): boolean {
  const { key } = useLocation();
  const [under, setUnder] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const heading = [...document.querySelectorAll<HTMLElement>("[data-page-title]")].find((el) => el.getClientRects().length > 0);
    if (!heading) {
      setUnder(true);
      return;
    }
    const bar = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h")) || 48;
    const io = new IntersectionObserver(([entry]) => setUnder(!!entry && !entry.isIntersecting && entry.boundingClientRect.top < bar), {
      rootMargin: `-${bar}px 0px 0px 0px`,
    });
    io.observe(heading);
    return () => io.disconnect();
  }, [enabled, key]);
  return enabled && under;
}
