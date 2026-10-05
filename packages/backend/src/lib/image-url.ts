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
    const url = new URL(src);
    if (TRACKING_HOSTS.has(url.hostname)) return true;
    // HTML video pages are never image bytes. Match the same watch/embed/share
    // shapes isVideoPageUrl already treats as players (embed, youtu.be, vimeo).
    return isVideoPageUrl(src);
  } catch {
    return false;
  }
}
