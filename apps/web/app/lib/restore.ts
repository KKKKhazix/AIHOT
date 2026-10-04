// Return-position snapshots for list pages: loaded cards, expanded/collapsed state and the
// on-screen anchor (card key + offset), keyed by the history entry. Session-scoped, not a contract.

import { useEffect } from "react";
import { sessionCache } from "./session-cache";

const PREFIX = "aihot:list:";
const MAX_AGE_MS = 30 * 60 * 1000;

export interface ListSnapshot<T> {
  savedAt: number;
  data: T;
  anchor: { key: string; offset: number } | null;
  scrollY: number;
}

const snapshots = sessionCache<ListSnapshot<unknown>>(PREFIX, MAX_AGE_MS);

/**
 * True when this document was loaded by the reader's reload. A reload asks for the latest list (the
 * home page has no "new items" prompt), so it never restores a saved list; back and forward do.
 */
export function isReload(): boolean {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === "reload";
}

/** Saves the list as it is now, anchored on the first card ([data-card-key]) still below the bar. */
export function saveSnapshot<T>(historyKey: string, data: T, flush = false) {
  let anchor: ListSnapshot<T>["anchor"] = null;
  // Cards follow vertical order. A closing date still has clipped children until its animation
  // ends; exclude them so only the visible list participates in the position search.
  const cards = document.querySelectorAll<HTMLElement>("[data-card-key]:not(.anim-collapse-out *)");
  const head = cards[0]?.getBoundingClientRect();
  let start = 0;
  // Near the top one read is enough; deep returns use a logarithmic search.
  let end = head && head.bottom > 72 ? 0 : cards.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (cards[middle]!.getBoundingClientRect().bottom > 72) end = middle;
    else start = middle + 1;
  }
  const first = cards[start];
  if (first) {
    anchor = { key: first.dataset.cardKey!, offset: start === 0 ? head!.top : first.getBoundingClientRect().top };
  }
  snapshots.set(historyKey, { savedAt: Date.now(), data, anchor, scrollY: window.scrollY });
  if (flush) snapshots.flush();
}

/**
 * Saves the snapshot (with `data()` at that moment) whenever the reader leaves this history entry: a link
 * within the site, back or forward, or the page going away.
 */
export function useSaveOnLeave(historyKey: string, data: () => unknown) {
  useEffect(() => {
    const save = () => saveSnapshot(historyKey, data());
    const onHide = () => saveSnapshot(historyKey, data(), true);
    // A prefetched navigation can commit without a loading render. Capture its anchor before the
    // router replaces the list; modifiers/new tabs leave this history entry in place.
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const to = new URL(link.href, window.location.href);
      if (to.origin === window.location.origin && to.pathname + to.search !== window.location.pathname + window.location.search) save();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", save);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", save);
      window.removeEventListener("pagehide", onHide);
    };
  }, [historyKey]);
}

export function readSnapshot<T>(historyKey: string): ListSnapshot<T> | null {
  return snapshots.read(historyKey) as ListSnapshot<T> | null;
}

/** Puts the anchor card back at the same viewport offset (falls back to the raw scroll position). */
export function restoreAnchor(anchor: ListSnapshot<unknown>["anchor"], scrollY: number) {
  const apply = () => {
    if (anchor) {
      const el = document.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(anchor.key)}"]`);
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - anchor.offset;
        window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
        return;
      }
    }
    window.scrollTo({ top: scrollY, behavior: "instant" as ScrollBehavior });
  };
  requestAnimationFrame(() => {
    apply();
    // Images or late layout may shift content; settle once more.
    setTimeout(apply, 120);
  });
}
