import { SITE, withSubject } from "@aihot/industry/site";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Presence } from "../components/ui/Presence";
import { pageMeta } from "../lib/seo";
import { KEYS } from "../lib/local-state";
import { IconCheck, IconClose, IconImage } from "../components/icons";
import { RingMark } from "../components/Logo";
import { AsideCard, ReadingLayout } from "../components/ui/Page";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({ title: "反馈", description: `告诉 ${SITE.name} 哪里可以做得更好：内容、功能、接入或来源方的更正与下架请求。`, path: "/feedback", image: "/og/pages/feedback.png", noindex: true });
}

interface Draft {
  content: string;
  email: string;
  pageUrl: string;
}

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEYS.feedbackDraft);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return typeof d === "object" && d ? { content: String(d.content ?? ""), email: String(d.email ?? ""), pageUrl: String(d.pageUrl ?? "") } : null;
  } catch {
    return null;
  }
}

function writeDraft(d: Draft | null) {
  try {
    if (d === null) localStorage.removeItem(KEYS.feedbackDraft);
    else localStorage.setItem(KEYS.feedbackDraft, JSON.stringify({ ...d, savedAt: new Date().toISOString() }));
  } catch {
    // storage unavailable: the form still works
  }
}

const TIPS = ["出问题的页面或文章链接", "你看到了什么，原本想做什么", "有截图更好，记得先遮盖敏感信息"];

function FeedbackAside() {
  return (
    <>
      <AsideCard title="写清楚这几点，处理更快">
        <ol className="space-y-2.5">
          {TIPS.map((t, i) => (
            <li key={t} className="flex gap-2.5 text-[13px] leading-[1.6] text-ink-3">
              <span className="mono mt-px text-[11px] font-bold text-accent">{String(i + 1).padStart(2, "0")}</span>
              {t}
            </li>
          ))}
        </ol>
      </AsideCard>
      <AsideCard title="来源方">
        <p className="text-[13px] leading-[1.75] text-ink-3">如果你是来源方，希望更正、下架或调整展示方式，写明对应的文章链接和你的诉求即可。</p>
      </AsideCard>
    </>
  );
}

const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_TEXT = 2000;

export default function FeedbackPage() {
  const [params] = useSearchParams();
  const [draft, setDraft] = useState<Draft>({ content: "", email: "", pageUrl: params.get("from") ?? "" });
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "sending" | "done" | "error"; message?: string; id?: number }>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = readDraft();
    if (saved) setDraft((d) => ({ ...saved, pageUrl: d.pageUrl || saved.pageUrl }));
    else if (!params.get("from") && document.referrer.startsWith(location.origin)) setDraft((d) => ({ ...d, pageUrl: document.referrer }));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => writeDraft(draft.content || draft.email ? draft : null), 400);
    return () => clearTimeout(t);
  }, [draft]);

  useEffect(() => {
    if (!shot) return;
    return () => URL.revokeObjectURL(shot.url);
  }, [shot]);

  const pick = (file: File | null | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setState({ kind: "error", message: "截图需要是 PNG、JPEG 或 WebP。" });
    if (file.size > MAX_IMAGE) return setState({ kind: "error", message: "截图原图不超过 5 MB。" });
    setShot({ file, url: URL.createObjectURL(file) });
    setState({ kind: "idle" });
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) pick(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.content.trim().length < 2) return setState({ kind: "error", message: "请写下反馈内容。" });
    setState({ kind: "sending" });
    try {
      const form = new FormData();
      form.set("content", draft.content);
      form.set("email", draft.email);
      form.set("pageUrl", draft.pageUrl);
      if (shot) form.set("screenshot", shot.file);
      const res = await fetch("/api/site/feedback", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setState({ kind: "error", message: body.detail ?? "提交失败，请稍后再试。" });
      writeDraft(null);
      setState({ kind: "done", id: body.id });
      setDraft({ content: "", email: "", pageUrl: "" });
      setShot(null);
    } catch {
      setState({ kind: "error", message: "网络不太顺，草稿已保存在本机，稍后再提交。" });
    }
  };

  if (state.kind === "done") {
    return (
      <ReadingLayout>
        <div className="card px-6 py-14 text-center">
          <div className="anim-pop-in mx-auto flex size-14 items-center justify-center rounded-full bg-accent text-accent-contrast">
            <IconCheck size={26} />
          </div>
          <h1 className="mt-6 text-[22px] font-semibold text-ink">收到了，谢谢你</h1>
          <p className="mt-2 text-[14px] text-ink-3">
            反馈编号 <span className="mono font-semibold text-ink">#{state.id}</span>，需要回复时我们会引用这个编号。
          </p>
          <Link to="/" className="mt-8 inline-flex h-10 items-center rounded-full bg-ink px-6 text-[14px] font-medium text-bg transition-opacity hover:opacity-90">
            回到精选
          </Link>
        </div>
      </ReadingLayout>
    );
  }

  const field = "w-full rounded-card bg-bg-sunk text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent dark:bg-bg-muted/60 dark:focus:bg-surface";
  const label = "mb-2 block text-[13px] font-semibold text-ink";
  const canSend = draft.content.trim().length >= 2 && state.kind !== "sending";
  return (
    <ReadingLayout aside={<FeedbackAside />}>
      <header>
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">说说你的想法</h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-ink-3">发现 bug、想要的功能、看不顺眼的地方，都可以告诉我，我都会看到。</p>
      </header>

      <form
        onSubmit={submit}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={`card mt-6 overflow-hidden transition-shadow ${dragging ? "shadow-[0_0_0_3px_var(--accent-soft)] ring-1 ring-accent" : ""}`}
      >
        <div className="space-y-5 p-5 sm:p-6">
          <div>
            <label htmlFor="fb-content" className={label}>
              想说点什么？
            </label>
            <div className="relative">
              <textarea
                id="fb-content"
                required
                rows={9}
                maxLength={MAX_TEXT}
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                placeholder="例如：我在搜索某个关键词时遇到……我原本想……"
                className={`${field} block resize-y px-4 pb-8 pt-3.5 text-[14.5px] leading-relaxed`}
              />
              <span className="mono pointer-events-none absolute bottom-3 right-4 text-[11px] text-ink-4">
                {draft.content.length} / {MAX_TEXT}
              </span>
            </div>
          </div>

          <div>
            <label htmlFor="fb-email" className={label}>
              邮箱 <span className="font-normal text-ink-4">（选填）</span>
            </label>
            <input id="fb-email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="留下邮箱，我可以回信联系你" className={`${field} h-11 px-4 text-[14.5px]`} />
          </div>

          <div>
            <span className={label}>
              截图 <span className="font-normal text-ink-4">（选填）</span>
            </span>
            {shot ? (
              <div className="flex items-center gap-4 well rounded-card p-3">
                <img src={shot.url} alt="截图预览" className="h-16 w-24 shrink-0 rounded-control border border-line bg-surface object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-ink-2">{shot.file.name}</div>
                  <div className="mono mt-0.5 text-[11.5px] text-ink-4">{(shot.file.size / 1024 / 1024).toFixed(2)} MB</div>
                </div>
                <button type="button" aria-label="移除截图" onClick={() => setShot(null)} className="grid size-8 shrink-0 place-items-center rounded-full text-ink-4 transition-colors hover:bg-surface hover:text-ink">
                  <IconClose size={15} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={`group flex w-full items-center gap-3.5 rounded-card border border-dashed px-4 py-3.5 text-left transition-colors ${dragging ? "border-accent bg-accent-softer" : "border-line-strong hover:border-ink-4 hover:bg-bg-sunk/60"}`}
              >
                <span className="grid size-10 shrink-0 place-items-center well rounded-tile text-ink-3 transition-colors group-hover:text-accent">
                  <IconImage size={19} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-ink-2">添加一张问题截图</span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-4">粘贴或拖到这里也可以 · 请先遮盖敏感信息；PNG、JPEG 或 WebP，原图不超过 5 MB</span>
                </span>
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
          </div>

          <Presence show={state.kind === "error"} enter="anim-notice-in" exit="anim-fade-out" duration={160}>
            <p role="alert" className="rounded-tile bg-hot-soft px-3.5 py-2.5 text-[13px] text-hot">
              {state.kind === "error" ? state.message : ""}
            </p>
          </Presence>
        </div>

        <div className="flex flex-col-reverse gap-4 border-t border-line-soft bg-bg-sunk/50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 dark:bg-bg-muted/30">
          <p className="text-[12px] leading-relaxed text-ink-4 sm:max-w-[400px]">
            请勿提交密钥、身份证件或与问题无关的敏感信息。提交即表示你知悉反馈内容、选填邮箱、页面信息和截图将按
            <Link to="/privacy" className="text-accent hover:underline">
              隐私说明
            </Link>
            处理。
          </p>
          <button
            type="submit"
            disabled={!canSend}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 self-start rounded-full bg-accent px-6 text-[14px] font-medium text-accent-contrast transition-[background-color,opacity] hover:bg-accent-ink disabled:bg-line-strong disabled:text-ink-4 sm:self-auto"
          >
            {state.kind === "sending" && <RingMark className="size-4" spinning />}
            发送反馈
          </button>
        </div>
      </form>
    </ReadingLayout>
  );
}
