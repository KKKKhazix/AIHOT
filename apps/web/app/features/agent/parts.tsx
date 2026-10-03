// Building blocks of the Agent page: panel heads, numbered steps, copyable asks and addresses,
// quiet tip tiles, tables and the fold-away details under each panel.
import type { ReactNode } from "react";
import { CopyButton } from "../../components/CodeBlock";
import { IconChevronDown } from "../../components/icons";

/** A panel's head: the track and version in small mono, the promise, and one line of context. */
export function PanelHead({ label, title, children }: { label: string; title: string; children?: ReactNode }) {
  return (
    <header>
      <div className="mono text-[11.5px] uppercase tracking-[0.14em] text-ink-4">{label}</div>
      <h2 className="mt-1.5 text-[22px] font-semibold leading-[1.35] text-ink">{title}</h2>
      {children && <p className="mt-2 text-[14.5px] leading-[1.8] text-ink-3">{children}</p>}
    </header>
  );
}

/** Numbered steps joined by a hairline. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-7 space-y-8">{children}</ol>;
}

export function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3.5 before:absolute before:bottom-[-26px] before:left-[13.5px] before:top-9 before:w-px before:bg-line last:before:hidden">
      <span className="num grid size-7 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">{n}</span>
      <div className="min-w-0 pt-[3px]">
        <h3 className="text-[15.5px] font-semibold leading-snug text-ink">{title}</h3>
        {children && <div className="mt-1.5 text-[14px] leading-[1.8] text-ink-2">{children}</div>}
      </div>
    </li>
  );
}

/** A section inside a panel, under a hairline. */
export function Block({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-24 border-t border-line pt-6">
      <h3 className="mb-3 text-[16px] font-semibold text-ink">{title}</h3>
      <div className="text-[14px] leading-[1.8] text-ink-2">{children}</div>
    </section>
  );
}

/** A question or instruction to paste into an Agent, with its copy button. */
export function Ask({ text }: { text: string }) {
  return (
    <div className="mt-2.5 flex items-center gap-3 rounded-tile border border-line bg-surface py-2 pl-3.5 pr-2">
      <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-ink">{text}</span>
      <CopyButton text={text} className="shrink-0" />
    </div>
  );
}

/** One address to copy: the MCP server, a feed. */
export function Address({ url, label = "复制" }: { url: string; label?: string }) {
  return (
    <div className="mt-2.5 flex items-center gap-2 rounded-tile border border-line bg-surface py-2 pl-3.5 pr-2">
      <code className="mono min-w-0 flex-1 truncate text-[12.5px] text-ink">{url}</code>
      <CopyButton text={url} label={label} className="shrink-0" />
    </div>
  );
}

/** Quiet tiles for short rules of thumb; each has a small number, a title and one or two lines. */
export function Tips({ items }: { items: Array<{ title: string; text: ReactNode }> }) {
  return (
    <ol className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
      {items.map((t, i) => (
        <li key={t.title} className="well rounded-panel p-4">
          <div className="mono text-[11px] text-ink-4">0{i + 1}</div>
          <div className="mt-1 text-[14.5px] font-semibold text-ink">{t.title}</div>
          <p className="mt-1 text-[13px] leading-[1.7] text-ink-3">{t.text}</p>
        </li>
      ))}
    </ol>
  );
}

/** Fold-away details under a panel: one hairline per row, open with the chevron. */
export function Details({ items }: { items: Array<{ title: string; body: ReactNode }> }) {
  return (
    <div className="mt-10 border-b border-line">
      {items.map((it) => (
        <details key={it.title} className="disclosure group border-t border-line">
          <summary className="flex items-center justify-between gap-3 py-3.5 text-[14.5px] font-medium text-ink transition-colors hover:text-accent">
            {it.title}
            <IconChevronDown size={16} className="shrink-0 text-ink-4 transition-transform duration-200 group-open:rotate-180" />
          </summary>
          <div className="pb-5 text-[14px] leading-[1.8] text-ink-2">{it.body}</div>
        </details>
      ))}
    </div>
  );
}

export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" aria-hidden="true" />
          <span className="min-w-0">{it}</span>
        </li>
      ))}
    </ul>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="mono rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[0.88em] text-ink">{children}</code>;
}

/** A plain table on a card; long rows scroll sideways on phones. Group rows name a block of rows. */
export function Table({ head, rows, minWidth = 560 }: { head: string[]; rows: Array<{ group: string } | ReactNode[]>; minWidth?: number }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-left text-[13.5px]" style={{ minWidth }}>
        <thead className="bg-bg-sunk text-[12.5px] text-ink-3">
          <tr>{head.map((h) => <th key={h} className="px-3.5 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) =>
            "group" in r ? (
              <tr key={`g${i}`} className="border-t border-line">
                <td colSpan={head.length} className="bg-bg-sunk/40 px-3.5 pb-1.5 pt-3 text-[12px] font-semibold text-ink-3">{r.group}</td>
              </tr>
            ) : (
              <tr key={i} className="border-t border-line-soft align-top">
                {r.map((c, j) => <td key={j} className="px-3.5 py-2.5">{c}</td>)}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
