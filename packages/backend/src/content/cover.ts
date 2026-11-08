// The publisher's cover of an article whose body has no picture of its own: the picture its page declares for
// sharing. Many pages show that picture only in their header, above the text Readability reads (techcrunch.com,
// theverge.com, news.mit.edu), and their bodies were stored and shown as a wall of text. The cover is kept apart
// from the body (articles.cover) and set above it where the body is shown, so a feed that sends the same body
// again, a translation and a later body with pictures of its own all read it the same way.
import { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { escHtml } from "./sanitize.ts";

export interface Cover {
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
}

type Doc = ReturnType<typeof parseHTML>["document"];

/** Whether a body shows a picture of its own. */
export function hasPicture(html: string | null | undefined): boolean {
  return /<(?:img|picture|video)\b/i.test(html ?? "");
}

/**
 * Cards a platform draws from a page's text on a template, no picture of the article: GitHub's for every
 * release and repository (its name, first lines and contributor count), Hugging Face's for every model and
 * dataset (its name on a gradient).
 */
const DRAWN_CARD_HOSTS = new Set(["opengraph.githubassets.com", "cdn-thumbnails.huggingface.co"]);

/** The picture a page declares for sharing (og:image, else twitter:image), with its declared size and description. */
export function declaredCover(document: Doc, url: string): Cover | null {
  const meta = (name: string) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim() || null;
  const src = meta("og:image") ?? meta("twitter:image");
  const address = src ? URL.parse(src, url) : null;
  if (!address || !/^https?:$/.test(address.protocol) || DRAWN_CARD_HOSTS.has(address.hostname)) return null;
  const size = (name: string) => {
    const n = Number(meta(name));
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  return { url: address.toString(), width: size("og:image:width"), height: size("og:image:height"), alt: meta("og:image:alt") };
}

/**
 * A picture as compared with a site's own: a file by its address without the query, which often carries a
 * version or a size (apple-logo-og.jpg?202611031825); an image service by its whole address, whose query
 * names the picture (/_next/image?url=…).
 */
const pictureKey = (url: string) => {
  const u = new URL(url);
  return /\.[a-z0-9]{2,5}$/i.test(u.pathname) ? u.origin + u.pathname : u.toString();
};

const PAGE_READ = { timeoutMs: 15_000, maxBytes: 1024 * 1024, truncate: true };

/** A page's declared share picture (pictureKey); none for a page that cannot be read. */
async function readSharePicture(url: string): Promise<string | null> {
  try {
    const res = await guardedFetch(url, PAGE_READ);
    if (res.status !== 200 || !/html/i.test(res.headers.get("content-type") ?? "")) return null;
    const cover = declaredCover(parseHTML(res.text()).document, res.url);
    return cover ? pictureKey(cover.url) : null;
  } catch {
    // A page that cannot be read declares no picture of the site's own: the article keeps its cover.
    return null;
  }
}

/** A site's articles share its home, section and other pages: each is read once an hour, not once per article. */
const SITE_PAGE_MS = 3600_000;
const sitePictures = new Map<string, { at: number; page: string; picture: Promise<string | null> }>();
function remember(key: string, page: string): Promise<string | null> {
  const picture = readSharePicture(page);
  sitePictures.set(key, { at: Date.now(), page, picture });
  return picture;
}
function sitePagePicture(url: string): Promise<string | null> {
  const known = sitePictures.get(url);
  return known && Date.now() - known.at < SITE_PAGE_MS ? known.picture : remember(url, url);
}

const samePage = (a: URL, b: URL) => a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");

/**
 * The picture another article of the site declares. Any other one will do: the page read within the hour
 * serves every article of the site but itself, so a run storing many of them reads it once. The other is the
 * latest one in the store.
 */
async function otherArticlePicture(articleUrl: string): Promise<string | null> {
  const article = new URL(articleUrl);
  const key = `other:${article.origin}`;
  const known = sitePictures.get(key);
  if (known && Date.now() - known.at < SITE_PAGE_MS && !samePage(new URL(known.page), article)) return known.picture;
  const rows = await sql<{ url: string }[]>`
    SELECT url FROM articles WHERE starts_with(url, ${`${article.origin}/`}) AND url <> ${articleUrl}
    ORDER BY discovered_at DESC LIMIT 5`;
  const other = rows.map((r) => URL.parse(r.url)).find((u) => u && !samePage(u, article));
  return other ? remember(key, other.toString()) : null;
}

/**
 * The cover an article at `articleUrl` takes from what its page at `pageUrl` declares. An entry of a page (an
 * address with a fragment, as a changelog's dated entries) shares the page's picture, which is not the entry's.
 * Nor is the site's own share picture, set on articles that have none: the one its home page declares (Apple's
 * machine learning research, METR, Ollama), its section's, the page at the article's first path segment
 * (Apple's newsroom), or the one another of its articles declares too (arXiv's logo, on every paper while its
 * home page declares none).
 */
export async function articleCover(cover: Cover | null, articleUrl: string, pageUrl: string): Promise<Cover | null> {
  if (!cover || URL.parse(articleUrl)?.hash) return null;
  const page = new URL(pageUrl);
  const own = pictureKey(cover.url);
  const segments = page.pathname.split("/").filter(Boolean);
  if ((await sitePagePicture(new URL("/", page).toString())) === own) return null;
  if (segments.length > 1 && (await sitePagePicture(new URL(`/${segments[0]}`, page).toString())) === own) return null;
  return (await otherArticlePicture(articleUrl)) === own ? null : cover;
}

/**
 * The cover of an article whose body came without its page (a feed's text): the head of its page is read for it.
 * A page that cannot be read gives none; a failure of the store while checking it is no unreadable page.
 */
export async function fetchArticleCover(articleUrl: string): Promise<Cover | null> {
  let page: { cover: Cover | null; url: string };
  try {
    const res = await guardedFetch(articleUrl, PAGE_READ);
    if (res.status !== 200 || !/html/i.test(res.headers.get("content-type") ?? "")) return null;
    page = { cover: declaredCover(parseHTML(res.text()).document, res.url), url: res.url };
  } catch {
    return null;
  }
  return articleCover(page.cover, articleUrl, page.url);
}

/** A body as it is shown: the cover first when the article's own body, `own`, has no picture (so both languages agree). */
export function withCover(html: string, cover: Cover | null | undefined, own: string | null | undefined): string {
  if (!cover || hasPicture(own)) return html;
  const size = `${cover.width ? ` width="${cover.width}"` : ""}${cover.height ? ` height="${cover.height}"` : ""}`;
  return `<figure><img src="${escHtml(cover.url)}" alt="${escHtml(cover.alt ?? "")}"${size}></figure>${html}`;
}
