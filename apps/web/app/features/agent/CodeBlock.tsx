import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { IconCheck, IconCopy } from "../../components/icons";

export function CopyButton({ text, label, className = "" }: { text: string; label?: string; className?: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [pressed, setPressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const idle = label ?? t("复制", "Copy");
  const said = { idle, copied: t("已复制", "Copied"), failed: t("请手动复制", "Copy manually") };
  return (
    <button
      type="button"
      onClick={async () => {
        let ok = true;
        try {
          await copyText(text);
        } catch {
          ok = false;
        }
        setPressed(true);
        setState(ok ? "copied" : "failed");
        // A second copy starts its own wait, so the label does not turn back early.
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), ok ? 1500 : 2400);
      }}
      className={`press inline-flex h-7 items-center gap-1 rounded-mark border border-line bg-surface px-2 text-ui-caption ${state === "copied" ? "text-ok" : state === "failed" ? "text-hot" : "text-ink-3 hover:border-line-strong hover:text-ink"} ${className}`}
      aria-label={said[state]}
    >
      <span key={state} className={pressed ? "anim-swap-in" : ""}>
        {state === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </span>
      {/* Copy and copied share one cell, so the button keeps its width as one fades into the other; the rare failure
          says what to do and may take more room. */}
      {state === "failed" ? (
        <span className="anim-fade-in">{said.failed}</span>
      ) : (
        <span className="grid justify-items-center">
          {(["idle", "copied"] as const).map((s) => (
            <span key={s} aria-hidden={s !== state || undefined} className={`[grid-area:1/1] transition-opacity ${s === state ? "" : "opacity-0"}`}>
              {said[s]}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** Code panel on the page's quiet grey, with a copy button; `lang` is only a label. Prompts in plain words `wrap`. */
export function CodeBlock({ code, lang, title, wrap = false, className = "my-4" }: { code: string; lang?: string; title?: string; wrap?: boolean; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-card border border-line bg-surface ${className}`}>
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
        <span className="text-ui-caption text-ink-4">{title ?? lang ?? ""}</span>
        <CopyButton text={code} />
      </div>
      <pre className={`mono bg-bg-sunk/60 px-4 py-4 text-ui-caption-lg leading-[1.75] text-ink-2 dark:bg-bg-muted/40 ${wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"}`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
