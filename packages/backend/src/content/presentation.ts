// Reuse translated wording when only the source's layout, media or link destinations change.
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { isNonArticleImage } from "../lib/image-url.ts";
import { collapseWhitespace, htmlBlockText } from "../lib/text.ts";
import { isXVideoUrl } from "../lib/video-url.ts";

const BLOCK = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dt,dd,caption";
const MEDIA = "picture,video,img";

export class PresentationMismatch extends Error {}

export interface PresentationSnapshot {
  bodyText?: string | null;
  html?: string | null;
  xArticleHtml?: string | null;
  cover?: Record<string, any> | null;
  media?: Array<Record<string, any>> | null;
  xPost?: Record<string, any> | null;
}

/** Extracts visible/accessible attribute text preserved by sanitizeBody (img alt/title, link title). */
export function htmlAltText(html: string | null | undefined): string {
  if (!html) return "";
  const $ = cheerio.load(html, null, false);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    const clean = collapseWhitespace(raw ?? "");
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };
  $("img").each((_i, el) => {
    push($(el).attr("alt"));
    push($(el).attr("title"));
  });
  $("a[title]").each((_i, el) => push($(el).attr("title")));
  return out.join("\n");
}

export function mediaAltText(items: Array<Record<string, any>> | null | undefined): string {
  if (!Array.isArray(items) || !items.length) return "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const clean = collapseWhitespace(typeof item?.alt === "string" ? item.alt : "");
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out.join("\n");
}

function addImageUrl(urls: string[], seen: Set<string>, raw: unknown): void {
  if (typeof raw !== "string") return;
  const url = raw.trim();
  if (!url || seen.has(url)) return;
  if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) return;
  if (isNonArticleImage(url) || isXVideoUrl(url)) return;
  seen.add(url);
  urls.push(url);
}

/** Distinct displayable image URLs across cover, media arrays, X post/quoted media and body HTML. */
export function collectImageUrls(snap: PresentationSnapshot): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  addImageUrl(urls, seen, snap.cover?.url);
  const visitMedia = (items: Array<Record<string, any>> | null | undefined) => {
    if (!Array.isArray(items)) return;
    for (const m of items) {
      if (!m || typeof m !== "object") continue;
      if (m.kind === "video") {
        addImageUrl(urls, seen, m.poster);
      } else {
        addImageUrl(urls, seen, m.url);
        addImageUrl(urls, seen, m.poster);
      }
    }
  };
  visitMedia(snap.xPost?.media);
  visitMedia(snap.xPost?.quoted?.media);
  visitMedia(snap.media);
  for (const html of [snap.html, snap.xArticleHtml]) {
    if (!html) continue;
    const $ = cheerio.load(html, null, false);
    $("img[src]").each((_i, el) => addImageUrl(urls, seen, $(el).attr("src")));
    $("video[poster]").each((_i, el) => addImageUrl(urls, seen, $(el).attr("poster")));
  }
  return urls;
}

function textLinesOf(snap: PresentationSnapshot): string[] {
  const rawParts = [
    snap.bodyText,
    htmlBlockText(snap.html),
    htmlAltText(snap.html),
    htmlBlockText(snap.xArticleHtml),
    htmlAltText(snap.xArticleHtml),
    mediaAltText(snap.media),
    typeof snap.cover?.alt === "string" ? snap.cover.alt : null,
    typeof snap.xPost?.text === "string" ? snap.xPost.text : null,
    typeof snap.xPost?.quoted?.text === "string" ? snap.xPost.quoted.text : null,
    mediaAltText(snap.xPost?.media),
    mediaAltText(snap.xPost?.quoted?.media),
  ];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const part of rawParts) {
    if (!part) continue;
    for (const line of part.split(/\n+/)) {
      const clean = collapseWhitespace(line);
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        lines.push(clean);
      }
    }
  }
  return lines;
}

/** True when a presentation update introduces new text/alt blocks or new displayable images not yet reviewed. */
export function presentationAddsMaterial(previous: PresentationSnapshot, next: PresentationSnapshot): boolean {
  const prevUrls = new Set(collectImageUrls(previous));
  if (collectImageUrls(next).some((url) => !prevUrls.has(url))) return true;
  const prevLines = textLinesOf(previous);
  const prevSet = new Set(prevLines);
  const prevWhole = collapseWhitespace(prevLines.join(" "));
  for (const line of textLinesOf(next)) {
    if (!/[\p{L}\p{N}\p{S}\p{Extended_Pictographic}]/u.test(line)) continue;
    if (!prevSet.has(line) && !prevWhole.includes(line)) return true;
  }
  return false;
}

export function presentationCounts(html: string | null): { images: number; links: number } {
  const $ = cheerio.load(html ?? "", null, false);
  return { images: $("img").length, links: $("a[href]").length };
}

function textBlocks($: cheerio.CheerioAPI) {
  return $(BLOCK).toArray().filter(el => !$(el).find(BLOCK).length && !!$(el).text().trim());
}

/** Preserve wording only where each old source block still has the same inline text structure. */
export function rebaseTranslation(previous: string, next: string, translated: string): string {
  const old = cheerio.load(previous, null, false);
  const current = cheerio.load(next, null, false);
  const zh = cheerio.load(translated, null, false);
  const oldBlocks = textBlocks(old), newBlocks = textBlocks(current), translatedBlocks = textBlocks(zh);
  if (oldBlocks.length !== newBlocks.length || oldBlocks.length !== translatedBlocks.length) {
    throw new PresentationMismatch("正文段落结构已变化，需要正常重翻，不能只刷新展示");
  }
  const shell = (html: string) => {
    const $ = cheerio.load(html, null, false);
    $("a").each((i, el) => { (el as Element).attribs = { id: String(i) }; });
    $(MEDIA).each((_i, el) => { if (!$(el).parents(MEDIA).length) $(el).replaceWith("⟦media⟧"); });
    return collapseWhitespace($.html());
  };
  oldBlocks.forEach((block, i) => {
    const fresh = newBlocks[i]!;
    if (shell(old(block).html() ?? "") !== shell(current(fresh).html() ?? "")) {
      throw new PresentationMismatch(`第 ${i + 1} 段的文字或内联结构已变化，需要正常重翻，不能只刷新展示`);
    }
    const rendered = cheerio.load(zh(translatedBlocks[i]!).html() ?? "", null, false);
    const links = current(fresh).find("a").toArray();
    const oldLinks = old(block).find("a").toArray();
    const zhLinks = rendered("a").toArray();
    const media = current(fresh).find(MEDIA).toArray().filter(el => !current(el).parentsUntil(fresh, MEDIA).length);
    const oldMedia = old(block).find(MEDIA).toArray().filter(el => !old(el).parentsUntil(block, MEDIA).length);
    const zhMedia = rendered(MEDIA).toArray().filter(el => !rendered(el).parents(MEDIA).length);
    if (links.length !== zhLinks.length || media.length !== zhMedia.length || oldLinks.some((link, k) => link.attribs.href !== zhLinks[k]?.attribs.href)) {
      throw new PresentationMismatch(`第 ${i + 1} 段的译文链接或图片无法对应，需要正常重翻`);
    }
    zhLinks.forEach((link, k) => { link.attribs = { ...links[k]!.attribs }; });
    // The model may move media tokens within a sentence. Match the original token, never its
    // position in the translated wording; repeated identical tokens must have the same replacement.
    const replacements = new Map<string, string[]>();
    oldMedia.forEach((el, k) => {
      const key = old.html(el), replacement = current.html(media[k]!);
      const matches = replacements.get(key) ?? [];
      if (matches.some(value => value !== replacement)) throw new PresentationMismatch(`第 ${i + 1} 段的重复图片无法唯一对应，需要正常重翻`);
      matches.push(replacement);
      replacements.set(key, matches);
    });
    zhMedia.forEach(el => {
      const replacement = replacements.get(rendered.html(el))?.shift();
      if (replacement === undefined) throw new PresentationMismatch(`第 ${i + 1} 段的译文图片无法对应，需要正常重翻`);
      rendered(el).replaceWith(replacement);
    });
    current(fresh).html(rendered.html());
  });
  return current.html();
}
