import * as cheerio from "cheerio";
import { marked } from "marked";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";

/** Jina returns page Markdown, which can include the publisher's navigation and recommendations. */
export function markdownBody(markdown: string, url: string): string {
  const page = new URL(url);
  const openaiArticle = page.hostname === "openai.com" && page.pathname.startsWith("/index/");
  if (openaiArticle) {
    // Reader splits an italic caption around its link; the invisible window hint makes its
    // adjacent underscores intraword delimiters. Join the caption without changing the link.
    markdown = markdown.replace(/_\[_([^\]\n]+?)_([\u2060\s]*\(opens in a new window\))\]\((https?:\/\/[^\s)]+)\)_/g, " [$1$2]($3)");
  }
  let html = marked.parse(markdown, { async: false, gfm: true });
  if (openaiArticle) {
    const $ = cheerio.load(html, null, false);
    const title = $("h1").first();
    // OpenAI's rendered pages put desktop/mobile navigation before the article's H1.
    if (title.length) title.prevAll().remove();
    // Both responsive copies of the article TOC consist entirely of links to this page's anchors.
    $("ul").filter((_, list) => {
      const links = $(list).find("a");
      return links.length > 0 && !$(list).clone().find("a").remove().end().text().trim()
        && links.toArray().every((link) => {
          const target = URL.parse($(link).attr("href") ?? "", url);
          if (!target) return false;
          return target.origin === page.origin && target.pathname === page.pathname && !!target.hash;
        });
    }).each((_, list) => {
      const previous = $(list).prev("p");
      if (previous.text().trim() === $(list).find("a").first().text().trim()) previous.remove();
      $(list).remove();
    });
    // Keep author and evaluation notes; the following section is the site's recommendation feed.
    const footer = $("h2, h3").filter((_, h) => /^(?:Keep reading|Continue reading)$/i.test($(h).text().trim())).first();
    if (footer.next().find('a[href="https://openai.com/news/"]').length) {
      footer.nextAll().remove();
      footer.remove();
    }
    html = $.html();
  }
  return trimTrailingChrome(sanitizeBody(html, url));
}
