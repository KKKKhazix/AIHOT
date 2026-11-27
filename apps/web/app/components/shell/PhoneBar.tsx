// The phone shell's top bar (below lg). Left: where back leads, or the brand; middle: the page's title
// once its own heading ([data-page-title]) has scrolled up under the bar, or a switch that always shows;
// right: actions. Pages render one responsive h1 of their own instead of duplicating it here.
import { forwardRef, useEffect, useLayoutEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useLocation } from "react-router";
import { IconChevronLeft } from "../icons";
import { historyIndex, previousScreen } from "./screens";
import { markBack } from "./transitions";
import { useNavigate } from "../../lib/link";
import { useT, type Text } from "../../lib/i18n";

export interface BackTarget {
  /** Where back goes when this page was opened directly (no page of ours behind it). */
  to: string;
  /** What the button says then; otherwise it names the page behind, or reads "返回". */
  label: Text;
}

export function PhoneBar({ back, title, leading, center, actions }: {
  back?: BackTarget;
  /** The page's name, shown in the bar once the page's heading ([data-page-title]) is under it. */
  title?: ReactNode;
  leading?: ReactNode;
  /** Always shown in the middle instead of the title (精选 | 全部). */
  center?: ReactNode;
  actions?: ReactNode;
}) {
  const scrolled = useScrolled();
  const titleShown = useHeadingUnderBar(!center && !!title);
  const wideCenter = !!center && !back && !leading;
  return (
    <header
      data-phone-bar=""
      className={`bleed sticky top-0 z-40 bg-bg/85 backdrop-blur-xl backdrop-saturate-150 transition-shadow lg:hidden ${scrolled ? "shadow-[0_1px_0_var(--line-soft)]" : ""}`}
    >
      <div className={`-mx-2.5 grid h-[var(--bar-h)] items-center ${wideCenter ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"}`}>
        {!wideCenter && <div className="flex min-w-0 items-center">{back ? <BackButton {...back} /> : leading}</div>}
        {/* A title not shown yet takes no width, so the back label is not cut short before it appears; one going
            away keeps its width until it has faded. */}
        <div
          className={`flex min-w-0 justify-center ${wideCenter ? "" : "max-w-[calc(100vw-184px)]"}`}
          style={!center && !titleShown ? { maxWidth: 0, transition: "max-width 0s linear var(--dur-leave)" } : undefined}
        >
          {center ?? (
            title && (
              <span
                aria-hidden={!titleShown}
                className={`truncate text-ui-body-plus font-semibold text-ink transition-[opacity,translate] ${titleShown ? "translate-y-0 opacity-100 duration-(--dur-move)" : "translate-y-1 opacity-0 duration-(--dur-leave)"}`}
              >
                {title}
              </span>
            )
          )}
        </div>
        <div className="flex min-w-0 items-center justify-end">{actions}</div>
      </div>
    </header>
  );
}

/** "‹ 精选": back through the reader's history, or to the page's parent when it was opened directly. */
function BackButton({ to, label }: BackTarget) {
  const navigate = useNavigate();
  const { key } = useLocation();
  const t = useT();
  const [text, setText] = useState(t(label));
  useLayoutEffect(() => {
    if (historyIndex() === 0) return setText(t(label));
    const behind = previousScreen();
    setText(behind ? t(behind) : t("返回", "Back"));
  }, [key, label, t]);
  return (
    <button
      type="button"
      onClick={() => {
        markBack();
        if (historyIndex() > 0) navigate(-1);
        else navigate(to, { viewTransition: true });
      }}
      className="flex h-11 min-w-11 items-center pl-1 pr-2 text-ui-body-lg text-accent transition-opacity active:opacity-50"
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
