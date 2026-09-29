import { useEffect, useId, useState, type CSSProperties, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { LbConfidence, LbStability } from "@aihot/contracts/leaderboard";
import { LB_CONFIDENCE_LABELS } from "@aihot/contracts/leaderboard";

const DOT: Record<LbConfidence, string> = {
  HIGH: "bg-ok",
  MEDIUM: "bg-accent",
  LOW: "bg-amber",
};

function rangeText(s: LbStability): string {
  return s.from === s.to ? `第 ${s.from} 名` : `${s.from}—${s.to} 名`;
}

function position(r: DOMRect): CSSProperties {
  return { left: Math.max(8, Math.min(r.left + r.width / 2 - 112, document.documentElement.clientWidth - 232)), ...(r.top > 160 ? { bottom: window.innerHeight - r.top + 8 } : { top: r.bottom + 8 }) };
}

/** Confidence as a dotted label. On desktop, hovering a sensitive ranking shows its scenario rank range. */
export function EvidenceBadge({ confidence, stability, rank }: { confidence: LbConfidence; stability: LbStability | null; rank: number }) {
  const id = useId();
  const [at, setAt] = useState<CSSProperties | null>(null);
  const open = at !== null;
  useEffect(() => {
    if (!open) return;
    // Scrolling never fires mouseleave (the pointer does not move), so the only
    // reliable dismissal is closing the tooltip on scroll itself.
    const close = () => setAt(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const show = (e: SyntheticEvent<HTMLSpanElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt(position(r));
  };
  const label = LB_CONFIDENCE_LABELS[confidence];
  const chip = (
    <small className="inline-flex items-center gap-1.5 text-[11px] leading-[17px] text-ink-4">
      <span className={`size-[5px] shrink-0 rounded-full ${DOT[confidence]}`} aria-hidden="true" />
      {label}
    </small>
  );
  if (!stability) return chip;
  const moved = stability.from !== stability.to || stability.unavailable > 0 || stability.incomplete > 0;
  return (
    <span className="inline-flex" tabIndex={moved ? 0 : -1} aria-describedby={moved && at ? id : undefined} onMouseEnter={moved ? show : undefined} onMouseLeave={() => setAt(null)} onFocus={moved ? show : undefined} onBlur={() => setAt(null)} onKeyDown={(e) => { if (e.key === "Escape") setAt(null); }}>
      {chip}
      {moved && at && createPortal(
        <span
          id={id}
          role="tooltip"
          style={at}
          className="pointer-events-none fixed z-[60] w-56 rounded-tile border border-line bg-raised p-3 text-left text-[12px] leading-relaxed text-ink-2 shadow-[var(--shadow-pop)]"
        >
          <span className="block text-[11px] text-ink-4">名次浮动范围</span>
          <span className="num block text-[15px] font-semibold text-ink">{rangeText(stability)}</span>
          <span className="mt-1.5 block text-ink-3">
            在 {stability.scenarios} 个对照情景中重新检查资格后的名次。
            {stability.unavailable > 0 && ` ${stability.unavailable} 个情景下参评证据不足。`}
            不是置信区间。
          </span>
        </span>, document.body
      )}
    </span>
  );
}
