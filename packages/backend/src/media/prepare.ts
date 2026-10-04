// Images of a newly selected item, prepared as it is selected: every rendition its card and its
// page ask the image proxy for is fetched and resized once (a first reader otherwise waits seconds
// for the source site), animations are re-encoded, and the share image is rendered before the
// content push makes chat apps fetch it.
import { convertAnimated, produceImage } from "./images.ts";
import { loadItemDetail } from "../publication/detail.ts";
import { toFeedItemSummary } from "../publication/items.ts";
import { loadItemOgCard } from "../publication/og.ts";
import { renderOg } from "./og.ts";
import { logError } from "../lib/log-error.ts";

/** The (source, mode) pairs the proxy URLs in these public answers point at. */
export function proxiedRenditions(answers: unknown[]): Array<{ url: string; mode: string }> {
  const text = JSON.stringify(answers).replaceAll("&amp;", "&").replaceAll("\\u0026", "&");
  const seen = new Map<string, { url: string; mode: string }>();
  for (const m of text.matchAll(/\/api\/img-proxy\?u=([^&"\s\\]+)&mode=([a-z0-9-]+)/g)) {
    const url = decodeURIComponent(m[1]!);
    seen.set(`${m[2]}|${url}`, { url, mode: m[2]! });
  }
  return [...seen.values()];
}

export async function prepareArticleMedia(articleId: string): Promise<{ renditions: number; failed: number; animatedSaved: number }> {
  const [zh, original] = await Promise.all([loadItemDetail(articleId), loadItemDetail(articleId, "original")]);
  if (zh.kind !== "found" || original.kind !== "found") return { renditions: 0, failed: 0, animatedSaved: 0 };
  let failed = 0;
  let animatedSaved = 0;
  const renditions = proxiedRenditions([toFeedItemSummary(zh.row), zh.item, original.item]);
  for (const { url, mode } of renditions) {
    try {
      const image = await produceImage(url, mode);
      if (image.type === "image/gif") animatedSaved += await convertAnimated(url, mode);
    } catch {
      // The request path tries again (and answers 502) if the source is still unavailable.
      failed += 1;
    }
  }
  return { renditions: renditions.length, failed, animatedSaved };
}

/**
 * Renders the current public article card into the shared disk cache before chat apps unfurl the
 * pushed link. No serving process is required. Best effort.
 */
export async function warmShareImage(articleId: string): Promise<boolean> {
  try {
    const card = await loadItemOgCard(articleId);
    if (!card) return false;
    await renderOg(card);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", msg: "share image preparation failed", articleId, err: logError(error) }));
    return false;
  }
}
