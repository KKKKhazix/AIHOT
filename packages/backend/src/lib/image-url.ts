// Reject non-content images at ingestion and public reads: extracted bodies can mislabel tracking
// endpoints and video pages as illustrations. Existing saved bodies follow the same rule.
import { isVideoPageUrl } from "./video-url.ts";

const TRACKING_HOSTS = new Set([
  "ids4.ad.gt", "ids.ad.gt", "secure.adnxs.com", "sync.1rx.io", "ssum-sec.casalemedia.com",
  "sync.smartadserver.com", "token.rubiconproject.com", "image2.pubmatic.com", "sync.go.sonobi.com", "onetag-sys.com",
]);

export function isNonArticleImage(src: string, width?: string, height?: string): boolean {
  if (width !== undefined && height !== undefined && Number(width) <= 1 && Number(height) <= 1) return true;
  try {
    if (TRACKING_HOSTS.has(new URL(src).hostname)) return true;
  } catch {
    return false;
  }
  // A video page is HTML, never image bytes. The same hosts also serve real icons and thumbnails, and
  // video links and video elements are outside this image-only exclusion.
  return isVideoPageUrl(src);
}
