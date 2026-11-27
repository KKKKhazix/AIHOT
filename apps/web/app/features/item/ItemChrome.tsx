// Supporting chrome for the article route: scroll progress line, share/copy helper, toast bar,
// phone preview while full text streams in, and the async error fallback.
import { useEffect, useRef, useState } from "react";
import { isRouteErrorResponse, useAsyncError, useRevalidator } from "react-router";
import type { FeedItemSummary, SiteItemDetail } from "@aihot/contracts/site";
import { addressRuns } from "@aihot/contracts/addresses";
import { ENGLISH } from "@aihot/contracts/english";
import { ITEM_COPY } from "@aihot/site";
import { IconMore } from "../../components/icons";
import { BarButton, PhoneBar } from "../../components/shell/PhoneBar";
import { SameEventBadge, SelectedBadge } from "../../components/ui/Badge";
import { MentionText } from "../../components/ui/MentionText";
import { Presence } from "../../components/ui/Presence";
import { ScoreLabel, shownScore } from "../../components/ui/Score";
import { copyText } from "../../lib/clipboard";
import { fullDateTime } from "../../lib/format";
import { localizePath, translator, useLocale, useT, type Locale } from "../../lib/i18n";
import { siteUrl } from "../../lib/seo";
import { ReaderToolbar } from "./ReaderTools";

/** A 2px accent line across the top that follows long bodies. */
export function ReadingProgress() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (ref.current) ref.current.style.transform = `scaleX(${max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0})`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  // It follows the scroll as it happens: a transition would trail the reader's thumb.
  return <div ref={ref} aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left bg-accent" style={{ transform: "scaleX(0)" }} />;
}

/** Touch screens with a system share sheet share through it; elsewhere sharing is copying the link. */
export function sharesBySheet(): boolean {
  return typeof navigator !== "undefined" && !!navigator.share && matchMedia("(pointer: coarse)").matches;
}

/** 分享: the system share sheet where there is one; otherwise, or when it fails other than by the reader cancelling, the link is copied. */
export async function shareOrCopy(item: Pick<SiteItemDetail, "id" | "title">, locale: Locale, notify: (text: string, problem?: boolean) => void): Promise<void> {
  const t = translator(locale);
  const url = `${siteUrl()}${localizePath(`/items/${item.id}`, locale)}`;
  if (sharesBySheet()) {
    try {
      await navigator.share({ title: item.title, url });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }
  try {
    await copyText(`${item.title}\n${url}`);
    notify(t("链接已复制", "Link copied"));
  } catch {
    notify(t("复制失败", "Couldn't copy"), true);
  }
}

/**
 * A short line over the page's foot, gone after a moment (longer for one that says something went wrong). Shown
 * again while it is up, it stays for its full time again.
 */
export function useToast(): [string | null, (text: string, problem?: boolean) => void] {
  const [toast, setToast] = useState<{ text: string; problem: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.problem ? 2400 : 1600);
    return () => clearTimeout(t);
  }, [toast]);
  return [toast?.text ?? null, (text, problem = false) => setToast({ text, problem })];
}

export function Toast({ text }: { text: string | null }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(80px+env(safe-area-inset-bottom))] z-50 flex justify-center lg:bottom-8">
      <Presence show={!!text} motion="float">
        <div role="status" className="rounded-full bg-ink px-4 py-2 text-ui-label text-bg shadow-[var(--shadow-pop)]">
          {text}
        </div>
      </Presence>
    </div>
  );
}

/** Phones, while the article loads: what the card showed, in the article's own places. */
export function ItemPreview({ preview }: { preview: FeedItemSummary }) {
  const t = useT();
  const locale = useLocale();
  const [toast, setToast] = useToast();
  const isX = preview.channel === "x" && !!preview.x;
  // A post reads under its author; one that publishes a long X Article reads like an article, under its headline.
  const isPost = isX && !preview.x!.article;
  // Without a reliable date from the original, the card's time is when it was collected, and says so.
  const shownAt = preview.publishedAt ?? preview.timelineAt;
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-8">
      {/* 更多 is there while loading too, so the bar does not change when the article arrives. */}
      <PhoneBar
        back={{ to: preview.selected ? "/" : "/all", label: preview.selected ? t("精选", "Top Picks") : t("全部", "All") }}
        title={isPost ? preview.x!.authorName : preview.title}
        actions={
          <BarButton label={t("更多操作", "More actions")} disabled className="disabled:opacity-40">
            <IconMore size={22} />
          </BarButton>
        }
      />
      <article className="pb-6 pt-3" aria-busy="true">
        <div className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-label text-ink-3 ${isPost ? "" : "mb-3"}`}>
          <span className="font-semibold text-ink-2">{isX ? preview.x!.authorName : preview.source.name}</span>
          {isX && <span>· @{preview.x!.handle} · X</span>}
          <span>·</span>
          {!preview.publishedAt && <span>{t("收录时间", "Added")}</span>}
          <time dateTime={shownAt} className="mono">{fullDateTime(shownAt)}</time>
          {preview.selected && <span className="ml-1">{preview.sameEvent ? <SameEventBadge /> : <SelectedBadge />}</span>}
          {shownScore(preview.score) !== null && (
            <span className="ml-1">
              <ScoreLabel score={preview.score} />
            </span>
          )}
        </div>
        {isPost ? <h1 className="sr-only">{preview.title}</h1> : <h1 data-page-title="" className="text-ui-title-2 font-bold leading-[1.38] tracking-[-0.01em] text-ink">{preview.title}</h1>}
        {preview.summary && (
          <section className={isPost ? "mt-4" : "mt-7"}>
            <div className="mb-2 text-ui-caption font-semibold text-accent">{isPost && preview.summary.replace(/\s+/g, " ").trim() === preview.title ? t("原文", "Original") : t("AI 导读", "AI brief")}</div>
            <p className="text-ui-heading-sm leading-[1.7] text-ink"><MentionText runs={addressRuns(preview.summary)} /></p>
          </section>
        )}
        {preview.reason && (
          <section className="mt-6 border-t border-line pt-4">
            <div className="mb-1 text-ui-caption font-semibold text-ink-3">{t(ITEM_COPY.reasonLabel, ENGLISH?.reasonLabel ?? ITEM_COPY.reasonLabel)}</div>
            <p className="text-ui-body leading-[1.75] text-ink-2">{preview.reason}</p>
          </section>
        )}
        <div className="mt-9 space-y-3 border-t border-line pt-6" aria-hidden="true">
          {[92, 100, 96, 88, 98, 64].map((w, i) => (
            <div key={i} className="skeleton h-4" style={{ width: `${w}%` }} />
          ))}
        </div>
      </article>
      <ReaderToolbar
        item={preview}
        originalLabel={isX ? t("原推", "View on X") : t("原文", "Original")}
        onShare={() => void shareOrCopy(preview, locale, setToast)}
      />
      <Toast text={toast} />
    </div>
  );
}

/** The article could not load after the tap: gone (withdrawn, merged away), or the service is busy. */
export function ItemGone() {
  const t = useT();
  const error = useAsyncError();
  const revalidator = useRevalidator();
  const gone = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="mx-auto max-w-sm pb-8">
      <PhoneBar back={{ to: "/", label: t("精选", "Top Picks") }} />
      <div className="py-24 text-center">
        <div className="text-ui-heading font-bold text-ink">{gone ? t("找不到这篇内容", "Article not found") : t("暂时无法加载", "Can't load this page")}</div>
        <p className="mt-2 text-ui-label-lg leading-relaxed text-ink-3">{gone ? t("链接可能有误，或者这篇内容已经下架。", "The link may be wrong, or this article has been taken down.") : t("服务暂时繁忙，请稍后再试。", "The service is busy right now. Please try again later.")}</p>
        {!gone && (
          <button type="button" onClick={() => void revalidator.revalidate()} className="mt-6 h-11 rounded-full border border-line-strong bg-surface px-5 text-ui-body-sm font-medium text-ink-2 active:bg-bg-sunk">
            {t("重试", "Try again")}
          </button>
        )}
      </div>
    </div>
  );
}
