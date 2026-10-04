// An article body as the server sent it (sanitised HTML, in the first HTML response), enhanced after
// hydration: code blocks get a head with the language and a copy button and are coloured on demand,
// and pictures that are not links open in the viewer, stepping through the body's pictures.
import { useEffect, useRef, useState } from "react";
import { Lightbox, type LightboxImage } from "../../components/ui/Lightbox";

/** Pictures worth enlarging: not inside a link, not tiny icons. */
function canZoom(img: HTMLImageElement): boolean {
  return !img.closest("a") && !(img.naturalWidth && img.naturalWidth < 120);
}

function zoomable(root: HTMLElement): HTMLImageElement[] {
  return [...root.querySelectorAll<HTMLImageElement>("img")].filter(canZoom);
}

function enhanceCode(root: HTMLElement): () => void {
  const blocks = [...root.querySelectorAll<HTMLPreElement>("pre")].filter((pre) => pre.textContent?.trim());
  if (!blocks.length) return () => {};
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let highlighter: Promise<typeof import("./highlight")> | undefined;
  const pending = new Map<Element, { code: HTMLElement; source: string; label: HTMLElement }>();
  // Plain code and copying are available immediately. Colour only code near the reader, and
  // download the language parser only when there is something there to colour.
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const block = pending.get(entry.target);
      if (!block) continue;
      pending.delete(entry.target);
      observer.unobserve(entry.target);
      colour(block.code, block.source, block.label);
    }
  }, { rootMargin: "200px 0px" });
  const observe = (pre: HTMLPreElement, code: HTMLElement, source: string, label: HTMLElement) => {
    pending.set(pre, { code, source, label });
    observer.observe(pre);
  };
  for (const pre of blocks) {
    const code = pre.querySelector("code") ?? pre;
    const source = code.textContent ?? "";
    const wrapped = pre.parentElement?.classList.contains("code-block");
    if (wrapped) {
      // Enhanced by an earlier run of this effect: only the colours may still be missing.
      const label = pre.parentElement!.querySelector<HTMLElement>(".code-block-head span");
      if (!code.classList.contains("hljs") && label) observe(pre, code, source, label);
      continue;
    }
    const shell = document.createElement("div");
    shell.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-block-head";
    const label = document.createElement("span");
    label.textContent = "代码";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-block-copy";
    button.textContent = "复制";
    button.setAttribute("aria-label", "复制代码");
    button.addEventListener("click", async () => {
      let ok = true;
      try {
        await navigator.clipboard.writeText(source);
      } catch {
        ok = false;
      }
      button.dataset.status = ok ? "copied" : "error";
      button.textContent = ok ? "已复制" : "请手动复制";
      const timer = setTimeout(() => {
        timers.delete(timer);
        button.dataset.status = "";
        button.textContent = "复制";
      }, ok ? 1800 : 2400);
      timers.add(timer);
    });
    head.append(label, button);
    pre.parentNode?.insertBefore(shell, pre);
    shell.append(head, pre);
    observe(pre, code, source, label);
  }
  function colour(code: HTMLElement, source: string, label: HTMLElement) {
    void (highlighter ??= import("./highlight"))
      .then(({ highlightCode }) => {
        if (disposed || !code.isConnected || code.classList.contains("hljs")) return;
        const coloured = highlightCode(source);
        if (!coloured) return;
        // highlight.js escapes the text it is given; its output is only that text and its own spans.
        code.innerHTML = coloured.html;
        code.classList.add("hljs");
        label.textContent = coloured.label;
      })
      .catch(() => {});
  }
  return () => {
    disposed = true;
    observer.disconnect();
    pending.clear();
    for (const t of timers) clearTimeout(t);
  };
}

export function ArticleBody({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<LightboxImage[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const cleanCode = enhanceCode(root);
    const mark = (img: HTMLImageElement) => {
      if (canZoom(img)) {
        img.classList.add("zoomable");
        img.tabIndex = 0;
        img.setAttribute("role", "button");
        img.setAttribute("aria-label", img.alt ? `查看大图：${img.alt}` : "查看大图");
      } else if (img.classList.contains("zoomable")) {
        img.classList.remove("zoomable");
        img.removeAttribute("tabindex");
        img.removeAttribute("role");
        img.removeAttribute("aria-label");
      }
    };
    for (const img of root.querySelectorAll("img")) mark(img);
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement) mark(e.target);
    };
    const showImage = (e: MouseEvent | KeyboardEvent) => {
      const img = e.target instanceof HTMLImageElement ? e.target : null;
      if (!img || !img.classList.contains("zoomable")) return;
      const list = zoomable(root);
      const index = list.indexOf(img);
      if (index < 0) return;
      e.preventDefault();
      setImages(list.map((i) => ({ src: i.src, alt: i.alt })));
      setOpen(index);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") showImage(e);
    };
    root.addEventListener("load", onLoad, true);
    root.addEventListener("click", showImage);
    root.addEventListener("keydown", onKeyDown);
    return () => {
      cleanCode();
      root.removeEventListener("load", onLoad, true);
      root.removeEventListener("click", showImage);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [html]);
  return (
    <>
      <div ref={ref} className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}
