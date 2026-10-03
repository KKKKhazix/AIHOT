// Phones: the article's own bottom toolbar in place of the tab bar — 收藏,
// 目录 for long reads (components/ui/OutlineSheet), 分享 and 原文 — sliding away while reading down and
// back on the way up or at the end; and the sheet of the article's further actions.
import { useEffect, useState, type ReactNode } from "react";
import { Sheet } from "../../components/ui/Sheet";
import { IconBookmark, IconExternal, IconList, IconShare } from "../../components/icons";
import { useStar } from "../feed/parts";
import type { FeedItemSummary } from "@aihot/contracts/site";

type Starrable = Pick<FeedItemSummary, "id" | "title" | "summary" | "source" | "publishedAt" | "score" | "selected">;

/** True while the reader is scrolling down through the page (not near its top or end). */
function useReadingDown(): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const end = document.documentElement.scrollHeight - window.innerHeight;
      if (y < 80 || y > end - 120) {
        setDown(false);
        last = y;
      } else if (Math.abs(y - last) > 6) {
        setDown(y > last);
        last = y;
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return down;
}

function Tool({ icon, label, onClick, href, pressed }: { icon: ReactNode; label: string; onClick?: () => void; href?: string; pressed?: boolean }) {
  const cls = `flex flex-col items-center justify-center gap-[2px] text-[10.5px] transition-colors active:opacity-50 disabled:opacity-40 ${pressed ? "font-semibold text-accent" : "text-ink-3"}`;
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {icon}
      {label}
    </a>
  ) : (
    <button type="button" onClick={onClick} disabled={!onClick} aria-pressed={pressed} className={cls}>
      {icon}
      {label}
    </button>
  );
}

export function ReaderToolbar({ item, originalUrl, originalLabel, onOutline, onShare }: {
  item: Starrable;
  /** Missing while the article is still loading. */
  originalUrl?: string;
  originalLabel: string;
  /** Long reads: opens the outline. */
  onOutline?: () => void;
  onShare: () => void;
}) {
  const hidden = useReadingDown();
  const star = useStar(item);
  return (
    <nav
      aria-label="阅读工具"
      className={`fixed inset-x-0 bottom-0 z-40 bg-surface/90 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-[0_-1px_0_var(--line)] backdrop-blur-xl backdrop-saturate-150 transition-transform duration-300 ease-[var(--ease-out-quart)] lg:hidden ${hidden ? "translate-y-full" : ""}`}
    >
      <div className={`mx-auto grid h-[50px] max-w-[640px] ${onOutline ? "grid-cols-4" : "grid-cols-3"}`}>
        <Tool
          pressed={star.on}
          onClick={star.toggle}
          label={star.on ? "已收藏" : "收藏"}
          icon={
            <span key={star.pulse} className={`flex ${star.pulse ? "anim-bump" : ""}`}>
              <IconBookmark size={22} filled={star.on} />
            </span>
          }
        />
        {onOutline && <Tool onClick={onOutline} label="目录" icon={<IconList size={22} />} />}
        <Tool onClick={onShare} label="分享" icon={<IconShare size={22} />} />
        {originalUrl ? <Tool href={originalUrl} label={originalLabel} icon={<IconExternal size={22} />} /> : <Tool label={originalLabel} icon={<IconExternal size={22} />} />}
      </div>
    </nav>
  );
}

export interface ActionRow {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect?: () => void;
  href?: string;
  download?: boolean;
}

/** The article's further actions as a sheet of rows (phones; desktop keeps its menu). */
export function ActionsSheet({ open, onClose, rows }: { open: boolean; onClose: () => void; rows: ActionRow[] }) {
  const row = "flex h-[52px] w-full items-center gap-3.5 rounded-tile px-3 text-left text-[16px] text-ink transition-colors active:bg-bg-sunk";
  return (
    <Sheet open={open} onClose={onClose} label="更多操作">
      <ul className="px-2 pt-2">
        {rows.map((r) => (
          <li key={r.key}>
            {r.href ? (
              <a href={r.href} download={r.download} onClick={onClose} className={row}>
                <span className="text-ink-3">{r.icon}</span>
                {r.label}
              </a>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  r.onSelect?.();
                }}
                className={row}
              >
                <span className="text-ink-3">{r.icon}</span>
                {r.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
