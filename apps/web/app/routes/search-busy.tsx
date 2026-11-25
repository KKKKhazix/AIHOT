import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { RingMark } from "@aihot/site/brand/Logo.tsx";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { titled } from "../lib/seo";
import { Link } from "../lib/link";
import { localeOf, pagePath, translator, useT } from "../lib/i18n";

export const handle: Screen = { tab: "featured" };

export function meta({ location }: { location: { pathname: string } }) {
  const t = translator(localeOf(location.pathname));
  return [{ title: titled(t("搜索繁忙", "Search is busy")) }, { name: "robots", content: "noindex, follow" }];
}
export function headers() {
  return { "Cache-Control": "no-store" };
}

const RETRY_AFTER_SECONDS = 5;
const SEARCH_PARAMS = ["q", "tag", "channel", "category", "page", "tab"];

/** The busy page after an overloaded search: the same search can be tried again after a few seconds. */
export default function SearchBusy() {
  const { pathname, search } = useLocation();
  const t = useT();
  const [wait, setWait] = useState(RETRY_AFTER_SECONDS);
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (wait > 0) return;
    for (const turn of mark.current?.querySelector("g")?.getAnimations() ?? []) {
      const at = turn.effect?.getComputedTiming().currentIteration ?? 0;
      turn.effect?.updateTiming({ iterations: at + 1 });
    }
  }, [wait]);
  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);
  const kept = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(search)) if (SEARCH_PARAMS.includes(k)) kept.append(k, v);
  const base = pagePath(pathname).startsWith("/all") ? "/all" : "/";
  const retry = kept.toString() ? `${base}?${kept}` : base;
  const hasSearch = kept.has("q");
  const button = "press inline-flex h-11 items-center rounded-full px-4 text-ui-label-lg lg:h-9 touch:h-11";
  return (
    <>
    <PhoneBar back={{ to: base, label: base === "/all" ? t("全部", "All") : t("精选", "Top Picks") }} />
    <div className="mx-auto max-w-sm py-24 text-center">
      {/* It turns while the wait runs and, once trying again is possible, finishes its turn and rests. */}
      <span ref={mark} className="block">
        <RingMark className="mx-auto mb-5 size-10 text-accent" spinning />
      </span>
      <h1 className="text-ui-heading font-bold text-ink">{t("搜索有点忙", "Search is busy")}</h1>
      <p aria-live="polite" className="mt-2 text-ui-body-sm leading-relaxed text-ink-3">
        {wait > 0
          ? t("现在搜索的人比较多，稍等几秒再试。列表浏览不受影响。", "A lot of people are searching right now. Try again in a few seconds—you can still browse the news as usual.")
          : t("现在可以再搜一次了。", "You can search again now.")}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2.5">
        {hasSearch &&
          (wait > 0 ? (
            <span aria-disabled="true" className={`${button} num cursor-default bg-bg-sunk font-medium text-ink-4`}>{t(`${wait} 秒后可重试`, `Try again in ${wait}s`)}</span>
          ) : (
            <Link to={retry} className={`${button} anim-fade-in bg-accent font-medium text-accent-contrast hover:bg-accent-ink`}>{t("再搜一次", "Search again")}</Link>
          ))}
        <Link to="/all" className={`${button} ${hasSearch ? "border border-line-strong bg-surface text-ink-2 hover:border-ink-4" : "bg-accent font-medium text-accent-contrast hover:bg-accent-ink"}`}>{t("浏览全部动态", `Browse all news`)}</Link>
        <Link to="/" className={`${button} border border-line-strong bg-surface text-ink-2 hover:border-ink-4`}>{t("回到精选", "Back to Top Picks")}</Link>
      </div>
    </div>
    </>
  );
}
