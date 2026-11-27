// Share poster: the server-rendered poster (with a QR code to the article), to save or hand to the
// system share sheet. Loaded on demand from the article page; a bottom sheet on phones, centred above.
import { useEffect, useState } from "react";
import { SITE } from "@aihot/site";
import { Sheet } from "../../components/ui/Sheet";
import { IconDownload, IconShare } from "../../components/icons";
import { ogPath, useLocale, useT } from "../../lib/i18n";
import { inWeChat } from "./ReaderTools";

export default function PosterSheet({ id, title, open, onClose }: { id: string; title: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const src = ogPath(`/og/posters/${id}.png`, useLocale());
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [canShareFile, setCanShareFile] = useState(false);
  // A poster that failed is tried again each time the sheet opens (the image element is mounted anew).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && failed) setFailed(false);
  }
  // Saving and sharing wait for the poster: before it shows they would hand over a broken file.
  const ready = loaded && !failed;
  // WeChat cannot save downloads; there the image is long-pressed.
  const wechat = inWeChat();

  useEffect(() => {
    if (!open) return;
    // Opened again after a poster that failed, it tries again.
    setFailed(false);
    try {
      setCanShareFile(!!navigator.canShare?.({ files: [new File([], "p.png", { type: "image/png" })] }));
    } catch {
      setCanShareFile(false);
    }
  }, [open]);

  async function share() {
    try {
      const blob = await (await fetch(src)).blob();
      await navigator.share({ files: [new File([blob], `${SITE.mcpPrefix}-${id}.png`, { type: "image/png" })], title });
    } catch {
      // cancelled or unsupported: saving stays available
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t("分享海报", "Share as image")} centered>
      <div className="flex flex-col items-center px-5 sm:px-7">
        <div className="relative aspect-[3/4] w-full max-w-[min(360px,calc((88dvh-200px)*0.75))] overflow-hidden rounded-card border border-line bg-bg-sunk">
          {!loaded && !failed && <div className="skeleton absolute inset-0 rounded-none" />}
          {failed ? (
            <p className="absolute inset-0 grid place-items-center px-6 text-center text-ui-label text-ink-3">{t("海报生成失败，请稍后再试。", "Couldn't create the image. Please try again later.")}</p>
          ) : (
            <img
              src={src}
              alt={t(`${title} · 分享海报`, `${title} · share image`)}
              className={`size-full object-contain transition-[opacity,scale] duration-(--dur-move) ${loaded ? "scale-100 opacity-100" : "scale-[0.985] opacity-0"}`}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          )}
        </div>
        <p className="mt-3 text-ui-caption-lg text-ink-3">
          {wechat ? t("长按图片保存或分享", "Long-press the image to save or share it.") : t("长按或右键图片可复制", "Long-press or right-click the image to copy it.")}
        </p>
        {(!wechat || canShareFile) && (
          <div className="mt-3 flex w-full max-w-[360px] gap-2">
            {!wechat && (
              <a
                href={ready ? src : undefined}
                download={`${SITE.mcpPrefix}-${id}.png`}
                aria-disabled={ready ? undefined : true}
                className="press inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-accent text-ui-body-sm font-medium text-accent-contrast hover:bg-accent-ink aria-disabled:pointer-events-none aria-disabled:opacity-40 lg:h-10 touch:h-11 sm:text-ui-label-lg"
              >
                <IconDownload size={15} />{t(" 保存图片", " Save image")}
              </a>
            )}
            {canShareFile && (
              <button type="button" onClick={share} disabled={!ready} className="press inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface text-ui-body-sm font-medium text-ink hover:border-ink-4 disabled:pointer-events-none disabled:opacity-40 lg:h-10 touch:h-11 sm:text-ui-label-lg">
                <IconShare size={15} />{t(" 分享", " Share")}
              </button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
