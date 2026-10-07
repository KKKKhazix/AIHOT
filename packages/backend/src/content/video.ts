import type { CheerioAPI } from "cheerio";
import { isNonArticleImage } from "../lib/image-url.ts";

/** Only video sources survive; a rejected poster must not leave a player with nothing to show. */
export function normalizeVideos($: CheerioAPI): void {
  $("source").each((_, el) => {
    const source = $(el);
    if (!source.parent().is("video") || !source.attr("src")?.trim()) source.remove();
  });
  $("video").each((_, el) => {
    const video = $(el);
    const poster = video.attr("poster");
    if (poster && isNonArticleImage(poster)) video.removeAttr("poster");
    if (video.attr("src")?.trim() || video.children("source[src]").length) {
      video.attr({ controls: "", playsinline: "", preload: "none" });
    } else {
      video.removeAttr("controls playsinline preload");
      if (!video.attr("poster")) {
        // Unwrap safe fallback content without joining the surrounding words.
        if (el.prev) video.before(" ");
        if (el.next) video.after(" ");
        video.replaceWith(video.contents());
      }
    }
  });
}
