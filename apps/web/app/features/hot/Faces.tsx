import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HOT_FACE_LIMIT, type HotParticipant } from "@aihot/contracts/site";
import { SourceAvatar } from "../../components/ui/SourceAvatar";
import { Presence } from "../../components/ui/Presence";
import { formatCount } from "../../lib/format";
import { useT } from "../../lib/i18n";

/**
 * Who is talking about a hot story: overlapping faces of the 精选组 sources in the order the server
 * gives (T1, T1.5, T2), then a count for everyone else, 氛围组 included. Hover lists every name; where
 * the faces are their own control (not inside a link), a tap or Enter opens the list, so phones and
 * keyboards reach it too.
 */
export function Faces({ participants, total, size = 24, interactive = true }: { participants: HotParticipant[]; total: number; size?: number; interactive?: boolean }) {
  const t = useT();
  const shown = participants.filter((p) => p.kind === "editorial").slice(0, HOT_FACE_LIMIT);
  const rest = total - shown.length;
  const names = participants.map((p) => p.name).join(t("、", ", "));
  const faces = (
    <>
      {shown.map((p, i) => (
        <span key={p.sourceId ?? p.name} className={`rounded-full ring-2 ring-surface ${i ? "-ml-1.5" : ""}`}>
          <SourceAvatar name={p.name} iconUrl={p.iconUrl} iconSrcSet={p.iconSrcSet} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span className="-ml-1.5 inline-flex items-center justify-center rounded-full bg-bg-sunk px-1.5 text-ui-micro-8 font-medium text-ink-3 ring-2 ring-surface dark:bg-bg-muted" style={{ height: size, minWidth: size }}>
          +{rest}
        </span>
      )}
    </>
  );
  if (!interactive) {
    return (
      <span className="relative z-10 flex shrink-0 items-center" title={names}>
        {faces}
      </span>
    );
  }
  return <FacesButton participants={participants} total={total} names={names}>{faces}</FacesButton>;
}

function FacesButton({ participants, total, names, children }: { participants: HotParticipant[]; total: number; names: string; children: React.ReactNode }) {
  const t = useT();
  // Where the list opens: under the faces, kept on screen; fixed, so a card's clipping never hides it.
  // Above the faces it hangs from their top edge (bottom), however short the list, so it grows out of them.
  const [at, setAt] = useState<{ top?: number; bottom?: number; left: number; below: boolean } | null>(null);
  const open = at !== null;
  // Closing, the list shrinks back where it was.
  const shownAt = useRef(at);
  if (at) shownAt.current = at;
  const root = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const listed = [...participants.filter((p) => p.kind === "editorial"), ...participants.filter((p) => p.kind !== "editorial")];
  const more = total - participants.length;
  return (
    <span ref={root} className="relative z-10 inline-flex shrink-0">
      <button
        type="button"
        title={names}
        aria-expanded={open}
        aria-controls={id}
        aria-label={t(`${total} 位参与者，查看名单`, `${formatCount(total, "en")} ${total === 1 ? "participant" : "participants"}, show the list`)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) return setAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          const below = window.innerHeight - r.bottom > 240;
          setAt({ ...(below ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }), left: Math.min(Math.max(8, r.left), document.documentElement.clientWidth - 248), below });
        }}
        className="-m-1 flex items-center rounded-full p-1 outline-offset-2"
      >
        {children}
      </button>
      {shownAt.current && createPortal(
        <Presence show={open} motion="pop">
          <span ref={popup} id={id} role="dialog" aria-label={t("参与讨论的来源", "Sources in the discussion")} style={shownAt.current ? { top: shownAt.current.top, bottom: shownAt.current.bottom, left: shownAt.current.left } : undefined} className={`fixed z-50 max-h-[240px] w-[240px] overflow-y-auto rounded-control border border-line bg-raised p-3 text-ui-caption-lg leading-relaxed text-ink-2 shadow-[var(--shadow-pop)] ${shownAt.current?.below === false ? "origin-bottom-left" : "origin-top-left"}`}>
            <span className="block">{listed.map((p) => p.name).join(t("、", ", "))}</span>
            {more > 0 && <span className="mt-2 block text-ui-caption-md text-ink-4">{t(<>另有 {more} 位未列出</>, <>{formatCount(more, "en")} more not listed</>)}</span>}
          </span>
        </Presence>, document.body
      )}
    </span>
  );
}
