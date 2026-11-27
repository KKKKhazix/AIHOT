import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { SITE } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import type { Route } from "./+types/feedback";
import { Collapse } from "../components/ui/Presence";
import { scrollBehavior, useSwapped } from "../lib/motion";
import { edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { KEYS, lastPage } from "../lib/local-state";
import { readJson, writeRaw } from "../lib/browser-storage";
import { IconCheck, IconClose, IconImage } from "../components/icons";
import { RingMark } from "@aihot/site/brand/Logo.tsx";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { useHydrated } from "../lib/hydration";
import type { WebModule } from "../modules";
import { webModules } from "../site-modules";
import { Link, useNavigate } from "../lib/link";
import { L, localeOf, translator, useLocale, useT, type Phrase } from "../lib/i18n";

export const handle: Screen = { tab: "me", name: L("反馈", "Feedback") };

export function headers() {
  return edgeTtl(300);
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  return pageMeta({
    locale,
    title: t("反馈", "Feedback"),
    description: t(`告诉 ${SITE.name} 哪里可以做得更好：内容、功能、接入或来源方的更正与下架请求。`, `Tell ${SITE.name} what could be better: content, features, integrations, or corrections and takedown requests from sources.`),
    path: "/feedback",
    image: "/og/pages/feedback.png",
    noindex: true,
  });
}

interface Draft {
  content: string;
  email: string;
  pageUrl: string;
}

function parseDraft(value: unknown): Draft | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  return { content: String(d.content ?? ""), email: String(d.email ?? ""), pageUrl: String(d.pageUrl ?? "") };
}

/** Drafts the site's modules keep elsewhere in this browser. */
const otherDrafts = () => webModules().flatMap((m) => (m.feedbackDraft ? [m.feedbackDraft] : []));
/** The signed-in reader's email: the contact field starts with it, and they can change or clear it. */
const signedInEmail = () => webModules().map((m) => m.signedInEmail?.() ?? null).find((email) => !!email) ?? "";

function readDraft(): Draft | null {
  let draft = parseDraft(readJson(KEYS.feedbackDraft));
  for (const other of otherDrafts()) draft ??= parseDraft(other.read());
  return draft;
}

/** Saves the draft in this browser, or clears it (null); false when the browser refused. */
function writeDraft(d: Draft | null): boolean {
  const saved = writeRaw(KEYS.feedbackDraft, d && JSON.stringify({ ...d, savedAt: new Date().toISOString() }));
  // Another draft is kept until this one is saved; a submitted draft clears them all.
  if (saved || d === null) for (const other of otherDrafts()) other.clear();
  return saved;
}

const TIPS: Phrase[] = [
  L("出问题的页面或文章链接", "A link to the page or article with the problem"),
  L("你看到了什么，原本想做什么", "What you saw, and what you were trying to do"),
  L("有截图更好，记得先遮盖敏感信息", "A screenshot helps; cover anything sensitive first"),
];
const BACK = { to: "/more", label: L("我的", "Me") };

/**
 * A refusal in the reader's language. The server explains its refusals in Chinese only: an English page says what
 * each kind means instead.
 */
function refusal(body: { detail?: string; code?: string }): Phrase {
  return L(body.detail ?? "提交失败，请稍后再试。", body.code === "rate_limited"
    ? "Too many submissions for now. Try again later; your draft is saved."
    : body.code === "invalid_request"
      ? "Part of the form couldn't be accepted. Check your email address and screenshot, then try again."
      : "Couldn't send it. Try again later.");
}

type Guide = NonNullable<WebModule["feedbackGuide"]>;

/** The guide of the module whose button opened this page (WebModule.feedbackGuide), if any. */
function guideFor(state: unknown): Guide | null {
  const name = state && typeof state === "object" ? (state as { feedbackFor?: unknown }).feedbackFor : null;
  return webModules().find((m) => m.name === name)?.feedbackGuide ?? null;
}

/** What the reader had already typed where the button was (the link's `state.content`), if anything. */
function carriedText(state: unknown): string | null {
  const text = state && typeof state === "object" ? (state as { content?: unknown }).content : null;
  return typeof text === "string" && text.trim() ? text : null;
}

function FeedbackAside({ tips }: { tips: string[] }) {
  const t = useT();
  return (
    <>
      <AsideCard title={t("写清楚这几点，处理更快", "These help us sort it out faster")}>
        <ol className="space-y-2.5">
          {tips.map((tip, i) => (
            <li key={tip} className="flex gap-2.5 text-ui-label leading-[1.6] text-ink-3">
              <span className="mono mt-px text-ui-caption-sm font-bold text-accent">{String(i + 1).padStart(2, "0")}</span>
              {tip}
            </li>
          ))}
        </ol>
      </AsideCard>
      <AsideCard title={t("来源方", "For sources")}>
        <p className="text-ui-label leading-[1.75] text-ink-3">{t("如果你是来源方，希望更正、下架或调整展示方式，写明对应的文章链接和你的诉求即可。", "If you represent one of our sources and want something corrected, taken down or shown differently, include a link to the article and let us know.")}</p>
      </AsideCard>
    </>
  );
}

/**
 * Some phones report a JPEG as image/jpg, or give no type at all: the file name decides then. The
 * server checks the picture's real bytes either way.
 */
function screenshotType(file: File): string {
  const type = file.type.trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (type && type !== "application/octet-stream") return type;
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return type;
}

const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_TEXT = 2000;

export default function FeedbackPage() {
  const t = useT();
  const locale = useLocale();
  const [params] = useSearchParams();
  // The guide comes with the button's navigation, which the server never sees: a page the server drew starts with
  // the site's own words, and turns to the guide once hydrated. Guides are written in Chinese only (their modules'
  // pages have no English edition), so English pages keep the site's own words.
  const { state: navigation, pathname, search, key: visit } = useLocation();
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const guide = hydrated && locale === "zh" ? guideFor(navigation) : null;
  const [draft, setDraft] = useState<Draft>({ content: "", email: "", pageUrl: params.get("from") ?? "" });
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "sending" | "done" | "error"; message?: string; id?: number }>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Not a draft of its own: the signed-in email alone is never saved as one, and comes back after sending.
  const prefilled = useRef("");

  useEffect(() => {
    const saved = readDraft();
    prefilled.current = signedInEmail();
    // The page the reader was on before coming here (tracked across in-site navigation, "更多" skipped);
    // a document the browser opened fresh falls back to its referrer.
    const before = params.get("from") ? null : (lastPage() ?? (document.referrer.startsWith(location.origin) ? document.referrer : null));
    const from = before ? new URL(before, location.origin).href : null;
    // What was just typed comes before an older draft; the email kept with that draft stays. It is taken once:
    // from here it is this page's draft, and a reload brings back what the reader has written since.
    const carried = carriedText(navigation);
    if (carried) {
      setDraft((d) => ({ content: carried, email: saved ? saved.email : prefilled.current, pageUrl: d.pageUrl || from || saved?.pageUrl || "" }));
      navigate(pathname + search, { replace: true, state: { ...(navigation as object), content: undefined } });
    } else if (saved) setDraft((d) => ({ ...saved, pageUrl: d.pageUrl || from || saved.pageUrl }));
    else setDraft((d) => ({ ...d, email: prefilled.current, pageUrl: from ?? d.pageUrl }));
  }, []);
  // Saved a moment after typing stops, and at once when the reader leaves within that moment.
  const unsaved = useRef<{ draft: Draft | null } | null>(null);
  useEffect(() => {
    const value = draft.content || (draft.email && draft.email !== prefilled.current) ? draft : null;
    unsaved.current = { draft: value };
    const t = setTimeout(() => {
      writeDraft(value);
      unsaved.current = null;
    }, 400);
    return () => clearTimeout(t);
  }, [draft]);
  useEffect(() => {
    const flush = () => {
      if (unsaved.current) writeDraft(unsaved.current.draft);
      unsaved.current = null;
    };
    // Leaving for another page of the site, or the browser closing, going back or reloading the page.
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  // 反馈 pressed again after sending opens an empty form for the next one.
  const sentOn = useRef<string | null>(null);
  useEffect(() => {
    if (state.kind === "done" && sentOn.current !== null && sentOn.current !== visit) setState({ kind: "idle" });
  }, [visit]);

  useEffect(() => {
    if (!shot) return;
    return () => URL.revokeObjectURL(shot.url);
  }, [shot]);

  const pick = (picked: File | null | undefined) => {
    if (!picked) return;
    const type = screenshotType(picked);
    if (!/^image\/(png|jpeg|webp)$/.test(type)) return setState({ kind: "error", message: t("截图需要是 PNG、JPEG 或 WebP。", "The screenshot needs to be a PNG, JPEG or WebP.") });
    const file = type === picked.type ? picked : new File([picked], picked.name, { type });
    if (file.size > MAX_IMAGE) return setState({ kind: "error", message: t("截图原图不超过 5 MB。", "Screenshots must be 5 MB or smaller.") });
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
    if (draft.content.trim().length < 2) return setState({ kind: "error", message: t("请写下反馈内容。", "Please enter your feedback.") });
    setState({ kind: "sending" });
    try {
      const form = new FormData();
      form.set("content", draft.content);
      form.set("email", draft.email);
      form.set("pageUrl", draft.pageUrl);
      if (shot) form.set("screenshot", shot.file);
      const res = await fetch("/api/site/feedback", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setState({ kind: "error", message: t(refusal(body)) });
      writeDraft(null);
      sentOn.current = visit;
      setState({ kind: "done", id: body.id });
      // The thanks takes the form's place at the top of the page; a reader who sent from further down is taken to it.
      window.scrollTo({ top: 0, behavior: scrollBehavior() });
      setDraft({ content: "", email: prefilled.current, pageUrl: "" });
      setShot(null);
    } catch {
      setState({ kind: "error", message: t("网络不太顺，草稿已保存在本机，稍后再提交。", "Connection failed. Your draft is saved on this device—try sending again later.") });
    }
  };

  // A picture removed: the place to add one fades back in where it was. (Above the thanks, which returns early.)
  const shotSwapped = useSwapped(shot ? "shot" : "none");

  if (state.kind === "done") {
    // Back to where the reader was before coming here, when the site knows it.
    const before = lastPage();
    return (
      <>
      {/* The bar stays: sending does not take the reader out of the page. A bar of its own, so it follows the
          thanks' heading rather than the form's that has gone. */}
      <PhoneBar key="done" back={BACK} title={t("反馈", "Feedback")} />
      <ReadingLayout>
        <div className="anim-fade-in card px-6 py-14 text-center">
          <div className="anim-pop-in mx-auto flex size-14 items-center justify-center rounded-full bg-accent text-accent-contrast">
            <IconCheck size={26} />
          </div>
          <h1 data-page-title="" className="mt-6 text-ui-heading-lg-sm font-semibold text-ink">{t("收到了，谢谢你", "Got it. Thank you")}</h1>
          <p className="mt-2 text-ui-body-sm text-ink-3">
            {t(
              <>反馈编号 <span className="mono font-semibold text-ink">#{state.id}</span>，需要回复时我们会引用这个编号。</>,
              <>Your feedback number is <span className="mono font-semibold text-ink">#{state.id}</span>. We'll mention it if we reply.</>,
            )}
          </p>
          <Link to={before ?? "/"} className="mt-8 inline-flex h-11 items-center rounded-full bg-ink px-6 text-ui-body-sm font-medium text-bg transition-opacity hover:opacity-90 lg:h-10 touch:h-11">
            {before ? t("回到刚才的页面", "Back to where you were") : t("回到精选", "Back to Top Picks")}
          </Link>
        </div>
      </ReadingLayout>
      </>
    );
  }

  const field = "w-full rounded-card bg-well text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent";
  const label = "mb-2 block text-ui-label font-semibold text-ink";
  const canSend = draft.content.trim().length >= 2 && state.kind !== "sending";
  return (
    <>
    <PhoneBar back={BACK} title={t("反馈", "Feedback")} />
    <ReadingLayout aside={<FeedbackAside tips={guide?.tips ?? TIPS.map((tip) => t(tip))} />}>
      <header>
        <h1 data-page-title="" className="text-ui-heading-lg font-semibold leading-[1.3] text-ink">{guide?.title ?? t("说说你的想法", "Tell us what you think")}</h1>
        <p className="mt-2 text-ui-body-sm-plus leading-relaxed text-ink-3">{guide?.lead ?? t(SITE.feedbackLead, ENGLISH?.feedback.lead ?? SITE.feedbackLead)}</p>
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
              {t("想说点什么？", "What's on your mind?")}
            </label>
            <div className="relative">
              <textarea
                id="fb-content"
                required
                rows={9}
                maxLength={MAX_TEXT}
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                placeholder={guide?.example ?? t(SITE.feedbackExample, ENGLISH?.feedback.example ?? SITE.feedbackExample)}
                className={`${field} block resize-y px-4 pb-8 pt-3.5 text-ui-body-lg leading-relaxed sm:text-ui-body-sm-plus`}
              />
              <span className="mono pointer-events-none absolute bottom-3 right-4 text-ui-caption-sm text-ink-4">
                {draft.content.length} / {MAX_TEXT}
              </span>
            </div>
          </div>

          <div>
            <label htmlFor="fb-email" className={label}>
              {t(<>邮箱 <span className="font-normal text-ink-4">（选填）</span></>, <>Email <span className="font-normal text-ink-4">(optional)</span></>)}
            </label>
            <input id="fb-email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder={t(SITE.feedbackEmailHint, ENGLISH?.feedback.emailHint ?? SITE.feedbackEmailHint)} className={`${field} h-11 px-4 text-ui-body-lg sm:text-ui-body-sm-plus`} />
          </div>

          <div>
            <span className={label}>
              {t(<>截图 <span className="font-normal text-ink-4">（选填）</span></>, <>Screenshot <span className="font-normal text-ink-4">(optional)</span></>)}
            </span>
            {/* The picture and the place to add one are the same height, so choosing or removing it moves nothing below. */}
            {shot ? (
              <div className="anim-fade-in flex min-h-[90px] items-center gap-4 well rounded-card p-3">
                <img src={shot.url} alt={t("截图预览", "Screenshot preview")} className="h-16 w-24 shrink-0 rounded-control border border-line bg-surface object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui-label font-medium text-ink-2">{shot.file.name}</div>
                  <div className="mono mt-0.5 text-ui-caption-md text-ink-4">{(shot.file.size / 1024 / 1024).toFixed(2)} MB</div>
                </div>
                <button type="button" aria-label={t("移除截图", "Remove screenshot")} onClick={() => setShot(null)} className="grid size-11 shrink-0 place-items-center rounded-full text-ink-4 transition-colors hover:bg-surface hover:text-ink lg:size-8 touch:size-11">
                  <IconClose size={15} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={`group flex min-h-[90px] w-full items-center gap-3.5 rounded-card border border-dashed px-4 py-3.5 text-left transition-colors ${shotSwapped ? "anim-fade-in" : ""} ${dragging ? "border-accent bg-accent-softer" : "border-line-strong hover:border-ink-4 hover:bg-bg-sunk/60"}`}
              >
                <span className="grid size-10 shrink-0 place-items-center well rounded-tile text-ink-3 transition-colors group-hover:text-accent">
                  <IconImage size={19} />
                </span>
                <span className="min-w-0">
                  <span className="block text-ui-label-lg font-semibold text-ink-2">{t("添加一张问题截图", "Add a screenshot of the problem")}</span>
                  <span className="mt-0.5 block text-ui-caption leading-relaxed text-ink-4">{/* Pasting and dropping are a computer's ways: phones pick a photo. */}
                    <span className="hidden lg:inline">{t("粘贴或拖到这里也可以 · ", "You can also paste or drop it here · ")}</span>
                    {t("请先遮盖敏感信息；PNG、JPEG 或 WebP，原图不超过 5 MB", "Cover anything sensitive first. PNG, JPEG or WebP, up to 5 MB")}</span>
                </span>
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>
        {/* Outside the spaced column, so the gap above it opens with it instead of appearing at once. */}
        <Collapse open={state.kind === "error"}>
          <div className="px-5 pb-5 sm:px-6">
            <p role="alert" className="rounded-tile bg-hot-soft px-3.5 py-2.5 text-ui-label text-hot">
              {state.kind === "error" ? state.message : ""}
            </p>
          </div>
        </Collapse>

        <div className="flex flex-col-reverse gap-4 border-t border-line-soft bg-bg-sunk/50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 dark:bg-bg-muted/30">
          <p className="text-ui-caption leading-relaxed text-ink-4 sm:max-w-[400px]">
            {t(
              <>
                请勿提交密钥、身份证件或与问题无关的敏感信息。提交即表示你知悉反馈内容、选填邮箱、页面信息和截图将按
                <Link viewTransition to="/privacy" className="text-accent hover:underline">
                  隐私说明
                </Link>
                处理。
              </>,
              // The privacy notice has no English edition: the link goes to the Chinese page.
              <>
                Please don't include passwords, API keys, ID documents or sensitive details unrelated to the problem. By sending, you understand that your
                feedback, optional email, page details and screenshot are handled as described in the{" "}
                <a href="/privacy" className="text-accent hover:underline">
                  privacy notice
                </a>{" "}
                (in Chinese).
              </>,
            )}
          </p>
          <button
            type="submit"
            disabled={!canSend}
            aria-busy={state.kind === "sending" || undefined}
            className={`press inline-flex h-11 shrink-0 items-center justify-center self-start rounded-full px-6 text-ui-body-sm font-medium lg:h-10 touch:h-11 sm:self-auto ${state.kind === "sending" ? "bg-accent text-accent-contrast opacity-80" : "bg-accent text-accent-contrast hover:bg-accent-ink disabled:bg-line-strong disabled:text-ink-4"}`}
          >
            {/* Both labels share one cell, so the button keeps its width while it sends. */}
            <span className="grid justify-items-center">
              <span aria-hidden={state.kind === "sending" || undefined} className={`[grid-area:1/1] transition-opacity ${state.kind === "sending" ? "opacity-0" : ""}`}>{t("发送反馈", "Send feedback")}</span>
              <span aria-hidden={state.kind !== "sending" || undefined} className={`[grid-area:1/1] inline-flex items-center gap-2 transition-opacity ${state.kind === "sending" ? "" : "opacity-0"}`}>
                <RingMark className="size-4" spinning={state.kind === "sending"} />
                {t("发送中…", "Sending…")}
              </span>
            </span>
          </button>
        </div>
      </form>
    </ReadingLayout>
    </>
  );
}
