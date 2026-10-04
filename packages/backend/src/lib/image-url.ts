// Reject non-content images at ingestion and public reads: extracted bodies can mislabel tracking
// endpoints and video pages as illustrations. Existing saved bodies follow the same rule.
const TRACKING_HOSTS = new Set([
  "ids4.ad.gt", "ids.ad.gt", "secure.adnxs.com", "sync.1rx.io", "ssum-sec.casalemedia.com",
  "sync.smartadserver.com", "token.rubiconproject.com", "image2.pubmatic.com", "sync.go.sonobi.com", "onetag-sys.com",
]);

export function isNonArticleImage(src: string, width?: string, height?: string): boolean {
  if (width !== undefined && height !== undefined && Number(width) <= 1 && Number(height) <= 1) return true;
  try {
    const url = new URL(src);
    if (TRACKING_HOSTS.has(url.hostname)) return true;
    // These are HTML video pages, never image bytes. The same hosts also serve real site icons;
    // thumbnails, video links and video elements remain outside this image-only exclusion.
    return /^(?:www\.|m\.)?youtube\.com$/.test(url.hostname) && /^\/(?:watch\/?|shorts\/[^/]+\/?)$/.test(url.pathname);
  } catch {
    return false;
  }
}
