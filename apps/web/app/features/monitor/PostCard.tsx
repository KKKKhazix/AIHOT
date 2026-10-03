import { useState } from "react";
import { Collapse } from "../../components/ui/Presence";
import type { CodexResetContextPost } from "@aihot/contracts/monitor";
import { IconArrowUpRight, IconChevronRight } from "../../components/icons";
import { SourceAvatar } from "../../components/ui/SourceAvatar";
import { stamp } from "./format";

export interface CardPost {
  id: string;
  publishedAt: string | null;
  translation: string | null;
  original: string;
  context: CodexResetContextPost[];
  url: string;
}

function Context({ c, original }: { c: CodexResetContextPost; original: boolean }) {
  return (
    <div className="mt-3 border-l-2 border-line-strong pl-3">
      <div className="text-[12px] text-ink-4">
        {c.relation === "quote" ? "引用" : "回复"}{" "}
        <a href={c.url} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-accent">
          @{c.author}
        </a>
      </div>
      <p className="mt-0.5 whitespace-pre-line text-[13px] leading-[1.75] text-ink-3">{original ? c.originalText : (c.text ?? c.originalText)}</p>
      {original && c.text && <p className="mt-1 whitespace-pre-line text-[12.5px] leading-[1.7] text-ink-4">{c.text}</p>}
    </div>
  );
}

/** A Tibo post: Chinese translation first, context below, the English original one tap away. */
export function PostCard({ post, stage, avatar, compact = false }: { post: CardPost; stage?: string; avatar?: string | null; compact?: boolean }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const hasTranslation = !!post.translation;
  return (
    <article className={`min-w-0 rounded-card border border-line-strong bg-surface ${compact ? "px-4 py-3" : "p-4 sm:px-6"}`}>
      <header className="flex items-center gap-2.5">
        <SourceAvatar name="Tibo" avatarUrl={avatar} size={36} />
        <span className="min-w-0 flex-1 leading-tight">
          <strong className="block text-[13px] font-semibold text-ink">Tibo</strong>
          <small className="block text-[12px] text-ink-4">@thsottiaux</small>
        </span>
        {stage && <span className="rounded-full bg-[rgba(28,39,51,0.04)] px-2 py-0.5 text-[12px] text-ink-4 dark:bg-white/[0.06]">{stage}</span>}
      </header>
      <blockquote className={`mt-3 whitespace-pre-wrap text-ink [overflow-wrap:anywhere] ${compact ? "text-[15px] leading-[1.75]" : "text-[15px] leading-[1.75] sm:text-[18px]"}`}>
        {hasTranslation ? post.translation : post.original}
      </blockquote>
      {!hasTranslation && <p className="mt-1 text-[11.5px] text-ink-4">暂无核对过的完整译文，显示原文。</p>}
      {post.context.map((c) => (
        <Context key={c.id} c={c} original={false} />
      ))}
      <footer className="mt-3 flex items-center justify-between gap-3 text-[12px] text-ink-4">
        <time className="num" dateTime={post.publishedAt ?? undefined}>
          {stamp(post.publishedAt)}
        </time>
        <a href={post.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-accent transition-colors hover:text-accent-ink">
          在 X 查看 <IconArrowUpRight size={12} />
        </a>
      </footer>
      {hasTranslation && (
        <>
          <button type="button" onClick={() => setShowOriginal((v) => !v)} aria-expanded={showOriginal} className="mt-3 flex w-full items-center gap-1 border-t border-line pt-3 text-left text-[12px] text-ink-4 transition-colors hover:text-ink-2">
            <IconChevronRight size={12} className={`transition-transform duration-200 ${showOriginal ? "rotate-90" : ""}`} />
            英文原文
          </button>
          <Collapse open={showOriginal} duration={200}>
            <div className="pt-2">
              <blockquote className="whitespace-pre-line text-[13px] leading-[1.75] text-ink-3" lang="en">
                {post.original}
              </blockquote>
              {post.context.map((c) => (
                <Context key={c.id} c={c} original />
              ))}
            </div>
          </Collapse>
        </>
      )}
    </article>
  );
}
