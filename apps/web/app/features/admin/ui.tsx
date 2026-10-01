// Shared admin building blocks: page frame, cards, stats, badges, tables, buttons, fields and a
// reason dialog (manual changes always carry a reason for the audit log).
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ago, bj } from "./format";

export function AdminPage({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pt-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink sm:text-[24px]">{title}</h1>
          {subtitle && <p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, right, children, className = "", pad = true }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`rounded-panel bg-surface ring-1 ring-line ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          {right && <div className="flex items-center gap-2 text-[12.5px] text-ink-3">{right}</div>}
        </div>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-hot" : tone === "warn" ? "text-amber" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="rounded-panel bg-surface px-4 py-3.5 ring-1 ring-line">
      <div className="text-[12.5px] text-ink-3">{label}</div>
      <div className={`num mt-1 text-[22px] font-semibold tracking-tight ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-ink-4">{hint}</div>}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "muted" | "accent" | "info";
const TONES: Record<Tone, string> = {
  ok: "bg-ok/10 text-ok ring-ok/20",
  warn: "bg-amber/10 text-amber ring-amber/25",
  bad: "bg-hot-soft text-hot ring-hot/25",
  muted: "bg-bg-sunk text-ink-3 ring-line",
  accent: "bg-accent-soft text-accent ring-accent/20",
  info: "bg-surface-2 text-ink-2 ring-line-strong",
};

export function Badge({ tone = "muted", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1 ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const c = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-amber" : tone === "bad" ? "bg-hot" : tone === "accent" ? "bg-accent" : "bg-ink-4";
  return (
    <span className="relative inline-flex size-2">
      {tone === "bad" && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-50 ${c}`} />}
      <span className={`relative inline-flex size-2 rounded-full ${c}`} />
    </span>
  );
}

export function healthTone(h: string | null | undefined): Tone {
  return h === "ok" ? "ok" : h === "degraded" ? "warn" : h === "failing" ? "bad" : "muted";
}

export function Time({ at, title }: { at: string | null | undefined; title?: string }) {
  if (!at) return <span className="text-ink-4">—</span>;
  return (
    <time dateTime={String(at)} title={title ?? bj(at, true)} className="num whitespace-nowrap" suppressHydrationWarning>
      {ago(at)}
    </time>
  );
}

export interface Column<T> {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  align?: "right";
}

export function DataTable<T>({ rows, columns, rowKey, empty = "暂无数据", onRowClick, dense }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string | number; empty?: ReactNode; onRowClick?: (r: T) => void; dense?: boolean }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-[12px] text-ink-3">
            {columns.map((c) => (
              <th key={c.key} className={`whitespace-nowrap px-3 py-2 font-medium ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`border-b border-line/70 last:border-0 ${onRowClick ? "cursor-pointer transition-colors hover:bg-bg-sunk/60" : ""}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`${dense ? "py-1.5" : "py-2.5"} px-3 align-top text-ink-2 ${c.align === "right" ? "num text-right" : ""} ${c.className ?? ""}`}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-ink-4">{children}</div>;
}

type ButtonTone = "primary" | "secondary" | "danger" | "ghost";
const BTN: Record<ButtonTone, string> = {
  primary: "bg-ink text-bg hover:opacity-85",
  secondary: "bg-surface text-ink ring-1 ring-line-strong hover:bg-bg-sunk",
  danger: "bg-hot text-white hover:opacity-90",
  ghost: "text-ink-2 hover:bg-bg-sunk",
};

export function Button({
  tone = "secondary",
  size = "md",
  busy,
  children,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; size?: "sm" | "md"; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-[opacity,background-color,transform] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 ${
        size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-9 px-3.5 text-[13.5px]"
      } ${BTN[tone]} ${className}`}
    >
      {busy && <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent" />}
      {children}
    </button>
  );
}

export function ButtonLink({ to, children, tone = "secondary", size = "md" }: { to: string; children: ReactNode; tone?: ButtonTone; size?: "sm" | "md" }) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-[opacity,background-color] ${
        size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-9 px-3.5 text-[13.5px]"
      } ${BTN[tone]}`}
    >
      {children}
    </Link>
  );
}

const INPUT = "w-full rounded-control bg-surface px-3 py-2 text-[13.5px] text-ink ring-1 ring-line-strong outline-none transition-shadow placeholder:text-ink-4 focus:ring-2 focus:ring-accent";

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-[12.5px] font-medium text-ink-2">{label}</span>
      <span className="[&>*]:w-full" id={id}>{children}</span>
      {hint && <span className="mt-1 block text-[12px] text-ink-4">{hint}</span>}
    </label>
  );
}

export function Input(props: React.ComponentProps<"input">) {
  return <input {...props} className={`${INPUT} ${props.className ?? ""}`} />;
}

export function Textarea(props: React.ComponentProps<"textarea">) {
  return <textarea {...props} className={`${INPUT} min-h-[84px] resize-y leading-relaxed ${props.className ?? ""}`} />;
}

export function Select({ children, ...props }: React.ComponentProps<"select">) {
  return (
    <select {...props} className={`${INPUT} appearance-none bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-8 ${props.className ?? ""}`} style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3 4.5l3 3 3-3' fill='none' stroke='%2366757a' stroke-width='1.4'/></svg>\")" }}>
      {children}
    </select>
  );
}

/** Link-based filter chips bound to one query parameter. */
export function FilterChips({ param, options }: { param: string; options: Array<{ value: string; label: ReactNode; count?: number }> }) {
  const [sp] = useSearchParams();
  const current = sp.get(param) ?? "";
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const next = new URLSearchParams(sp);
        if (o.value) next.set(param, o.value);
        else next.delete(param);
        next.delete("page");
        const active = current === o.value;
        return (
          <Link
            key={o.value || "all"}
            to={`?${next}`}
            preventScrollReset
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors ${active ? "bg-ink text-bg" : "bg-surface text-ink-2 ring-1 ring-line hover:bg-bg-sunk"}`}
          >
            {o.label}
            {o.count !== undefined && <span className={`num text-[11.5px] ${active ? "text-bg/70" : "text-ink-4"}`}>{o.count}</span>}
          </Link>
        );
      })}
    </div>
  );
}

export function Pager({ page, hasMore }: { page: number; hasMore: boolean }) {
  const [sp] = useSearchParams();
  const to = (p: number) => {
    const next = new URLSearchParams(sp);
    if (p > 1) next.set("page", String(p));
    else next.delete("page");
    return `?${next}`;
  };
  if (page <= 1 && !hasMore) return null;
  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-[13px]">
      {page > 1 && <ButtonLink to={to(page - 1)} size="sm">上一页</ButtonLink>}
      <span className="num px-2 text-ink-3">第 {page} 页</span>
      {hasMore && <ButtonLink to={to(page + 1)} size="sm">下一页</ButtonLink>}
    </div>
  );
}

export function Json({ value, collapsed = true, label = "原始数据" }: { value: unknown; collapsed?: boolean; label?: string }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group rounded-control bg-bg-sunk/70 ring-1 ring-line">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-[12px] text-ink-3 hover:text-ink-2">{label}</summary>
      {open && <pre className="max-h-[420px] overflow-auto px-3 pb-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{JSON.stringify(value, null, 2)}</pre>}
    </details>
  );
}

/**
 * A modal that collects a reason (and optional extra fields) before a manual change. The submit
 * handler receives the reason; returning true closes the dialog.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  danger,
  requireReason = true,
  children,
  onClose,
  onSubmit,
  busy,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireReason?: boolean;
  children?: ReactNode;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<boolean | void> | boolean | void;
  busy?: boolean;
}) {
  const [reason, setReason] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open) return;
    setReason("");
    const t = setTimeout(() => ref.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[75] flex items-end justify-center p-3 sm:items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={onClose} />
          <motion.form
            role="dialog"
            aria-modal="true"
            initial={{ y: 16, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 10, scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
            className="relative w-full max-w-lg rounded-sheet bg-raised p-5 shadow-2xl ring-1 ring-line-strong"
            onSubmit={async (e) => {
              e.preventDefault();
              if (requireReason && !reason.trim()) return;
              const closed = await onSubmit(reason.trim());
              if (closed !== false) onClose();
            }}
          >
            <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
            {description && <div className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{description}</div>}
            {children && <div className="mt-4 space-y-3">{children}</div>}
            <div className="mt-4">
              <Field label={requireReason ? "原因（写进审计记录）" : "备注（可选）"}>
                <Textarea ref={ref} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={requireReason ? "为什么做这个改动" : ""} rows={2} />
              </Field>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button tone="ghost" onClick={onClose}>取消</Button>
              <Button type="submit" tone={danger ? "danger" : "primary"} busy={busy} disabled={requireReason && !reason.trim()}>
                {confirmLabel}
              </Button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function KV({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink-2">{v ?? <span className="text-ink-4">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
