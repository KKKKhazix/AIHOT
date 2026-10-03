import { useState } from "react";
import { IconCheck, IconCopy } from "./icons";

export function CopyButton({ text, label = "复制", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`inline-flex h-7 items-center gap-1 rounded-mark border border-line bg-surface px-2 text-[12px] transition-colors ${copied ? "text-ok" : "text-ink-3 hover:border-line-strong hover:text-ink"} ${className}`}
      aria-label={copied ? "已复制" : label}
    >
      <span key={copied ? "ok" : "copy"} className={copied ? "anim-swap-in" : ""}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </span>
      {copied ? "已复制" : label}
    </button>
  );
}

/** Code panel on the page's quiet grey, with a copy button; `lang` is only a label. Prompts in plain words `wrap`. */
export function CodeBlock({ code, lang, title, wrap = false, className = "my-4" }: { code: string; lang?: string; title?: string; wrap?: boolean; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-card border border-line bg-surface ${className}`}>
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
        <span className="text-[12px] text-ink-4">{title ?? lang ?? ""}</span>
        <CopyButton text={code} />
      </div>
      <pre className={`mono bg-bg-sunk/60 px-4 py-4 text-[12.5px] leading-[1.75] text-ink-2 dark:bg-bg-muted/40 ${wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"}`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
