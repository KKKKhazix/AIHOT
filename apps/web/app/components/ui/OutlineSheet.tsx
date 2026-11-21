// An outline as a bottom sheet (phones): an article's headings, a report's pages. The section being read
// is marked, and choosing one scrolls there.
import { useCurrentSection } from "../../lib/motion";
import { Sheet } from "./Sheet";

export interface OutlineEntry {
  id: string;
  text: string;
  /** 2 or less: a top-level entry, numbered in order; deeper ones are indented. */
  level: number;
  /** In place of the running number ("" for none). */
  mark?: string;
  /** On the right: how much the section holds ("5 件"). */
  note?: string;
}

export function OutlineSheet({ open, onClose, outline, title = "目录" }: { open: boolean; onClose: () => void; outline: OutlineEntry[]; title?: string }) {
  const [current, go] = useCurrentSection(outline.map((o) => o.id), open);
  let n = 0;
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ol className="px-3">
        {outline.map((o) => {
          const top = o.level <= 2;
          if (top && o.mark === undefined) n += 1;
          const mark = o.mark ?? (top ? String(n).padStart(2, "0") : "");
          const on = o.id === current;
          return (
            <li key={o.id}>
              <a
                href={`#${o.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                  requestAnimationFrame(() => go(o.id));
                }}
                aria-current={on ? "location" : undefined}
                className={`flex min-h-12 items-center gap-3 rounded-tile px-2 py-2 transition-colors active:bg-bg-sunk ${on ? "bg-accent-softer text-accent" : ""} ${top ? "" : "pl-9"}`}
              >
                {top && <span className={`mono w-5 shrink-0 text-ui-label ${on ? "font-bold" : "text-ink-4"}`}>{mark}</span>}
                <span className={`min-w-0 flex-1 leading-[1.45] ${top ? "text-ui-body-plus" : "text-ui-body-sm"} ${on ? "font-semibold" : top ? "text-ink-2" : "text-ink-3"}`}>{o.text}</span>
                {on ? <span className="shrink-0 text-ui-caption-md font-semibold">正在读</span> : o.note && <span className="num shrink-0 text-ui-caption text-ink-4">{o.note}</span>}
              </a>
            </li>
          );
        })}
      </ol>
    </Sheet>
  );
}
