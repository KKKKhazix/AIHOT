// Video watch/share/embed addresses name players, whose controls and recommendations are not articles.
export function isVideoPageUrl(input: string): boolean {
  let url: URL;
  try { url = new URL(input); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (/^(?:www\.|m\.)?youtube\.com$/.test(host)) {
    return (/^\/watch\/?$/.test(url.pathname) && !!url.searchParams.get("v")) || /^\/(?:shorts|embed|v)\/[^/]+\/?$/.test(url.pathname);
  }
  if (host === "youtu.be") return /^\/[^/]+\/?$/.test(url.pathname);
  if (host === "vimeo.com" || host === "www.vimeo.com") return /^\/\d+(?:\/[a-zA-Z0-9]+)?\/?$/.test(url.pathname);
  return host === "player.vimeo.com" && /^\/video\/\d+\/?$/.test(url.pathname);
}
