// Advertising ID-sync endpoints were captured as images in older Jina bodies. They are not article
// illustrations, even when a tracking endpoint happens to return a one-pixel GIF.
const TRACKING_HOSTS = new Set([
  "ids4.ad.gt", "ids.ad.gt", "secure.adnxs.com", "sync.1rx.io", "ssum-sec.casalemedia.com",
  "sync.smartadserver.com", "token.rubiconproject.com", "image2.pubmatic.com", "sync.go.sonobi.com", "onetag-sys.com",
]);

export function isTrackingImage(src: string, width?: string, height?: string): boolean {
  if (width !== undefined && height !== undefined && Number(width) <= 1 && Number(height) <= 1) return true;
  try { return TRACKING_HOSTS.has(new URL(src).hostname.toLowerCase()); } catch { return false; }
}
