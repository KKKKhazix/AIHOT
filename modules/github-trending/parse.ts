import * as cheerio from "cheerio";

export type Period = "daily" | "weekly" | "monthly";

export interface TrendingRow {
  rank: number;
  repo: string;
  description: string | null;
  language: string | null;
  stars: number | null;
  starsPeriod: number | null;
  url: string;
}

const int = (text: string | undefined): number | null => {
  const m = (text ?? "").replace(/[,\s]/g, "").match(/^\d+$/);
  return m ? Number(m[0]) : null;
};

export function parseTrending(html: string): TrendingRow[] {
  const $ = cheerio.load(html);
  const rows: TrendingRow[] = [];
  $("article.Box-row").each((i, el) => {
    const node = $(el);
    const href = node.find("h2 a").attr("href");
    if (!href || !/^\/[^/]+\/[^/]+/.test(href)) return;
    const repo = href.replace(/^\//, "").split("/").slice(0, 2).join("/");
    const desc = node.find("p.col-9").text().trim();
    const lang = node.find("[itemprop=programmingLanguage]").text().trim();
    rows.push({
      rank: rows.length + 1,
      repo,
      description: desc || null,
      language: lang || null,
      stars: int(node.find("a[href$='/stargazers']").first().text()),
      starsPeriod: int(node.find("span.float-sm-right").text().match(/([\d,]+)\s+stars/)?.[1]),
      url: `https://github.com/${repo}`,
    });
  });
  return rows;
}
