/// <reference lib="dom" />
// Failure modes recorded before the metadata change:
// - filtered/search feeds compete with their parent or canonicalize to different content;
// - tracking and obsolete positioning parameters leak into canonical, or ordinary archives become noindex;
// - a report's title omits its visible lead, or metadata promotes a withdrawn citation;
// - an article invents a modification date from its source's publication date or omits its image;
// - a story has no machine-readable subject, or claims its first report is its own publication date;
// - the founder is tied to only one public profile, so search engines and AI answers cannot connect the
//   others to the site (2026-10-17);
// - an article whose own text is a summary's worth is kept from every engine instead of only from Google,
//   or its original-language page says otherwise;
// - an article names its author and publisher by an id defined only on the home page, so its own page names
//   neither, or has no publication date when its source gave none; indexable pages keep search results and
//   Discover from showing their picture large (2026-11-08);
// - the latest daily's search snippet repeats its lead article's, so two pages read alike; its heading never
//   says what readers search it by; or /daily/ stands as a page of its own (2026-11-08);
// - 全部动态's later pages and an event page of a single report compete in search with the pages that stand
//   for them, the first page and that report's own page, while their links stop being followed (2026-11-09);
// - a daily whose lead was withdrawn is headed in search by a report its highlights were only filled with (2026-11-09).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import * as cheerio from "cheerio";
import { reportDateLabel, type FeedItemSummary, type ReportCitation, type ReportDetail, type ReportKind, type SiteItemDetail, type StoryDetail } from "@aihot/contracts/site";
import { SEO_TITLES, SITE, withSubject } from "@aihot/site";
import { articleLd, readFilters, reportLd } from "../apps/web/app/lib/seo.ts";
import { dateLine } from "../apps/web/app/features/report/format.ts";
import { startWebServer, type WebServer } from "../apps/web/tests/web-server.ts";

const at = "2026-10-04T08:00:00.000Z";
const item: FeedItemSummary = { id: "metadata-fixture", title: "可核实的测试报道", summary: "报道摘要", reason: null, source: { name: "Fixture" }, publishedAt: at, timelineAt: at, category: "ai-models", tags: [], score: 80, selected: true, channel: "news", x: null };
const detail: SiteItemDetail = { ...item, x: null, originalTitle: null, links: { original: "https://example.org/report" }, discoveredAt: at, story: null, readingMode: "full", author: null, body: { zh: "<p>可核实的测试正文。</p>", original: null, zhKind: "original", complete: true }, outline: [], relatedStories: [], topics: [], tagTopics: {}, daily: null, indexable: true, googleNoindex: false, markdownAvailable: true, group: null, hasTranslation: false, bodyLanguage: "zh", mentions: [] };
/** Article pages by id: the fixture, one kept from Google only, one kept from every engine. */
const details: Record<string, SiteItemDetail> = {
  [item.id]: detail,
  "metadata-short": { ...detail, id: "metadata-short", googleNoindex: true },
  "metadata-hidden": { ...detail, id: "metadata-hidden", selected: false, indexable: false },
  "metadata-undated": { ...detail, id: "metadata-undated", publishedAt: null, discoveredAt: "2026-10-04T07:30:00.000Z" },
};
const citation = (available: boolean): ReportCitation => ({ itemId: available ? item.id : "withdrawn", title: available ? item.title : "已撤下的旧头条", summary: item.summary, sourceName: item.source.name, sourceUrl: detail.links.original, sourceIconUrl: null, firstParty: true, publishedAt: at, available });
/** A daily whose one entry was withdrawn: its highlights are only the reports a thin issue is filled with. */
const leadless = (): ReportDetail => ({ ...report("daily"), key: "2026-10-05", lead: null, leadItemId: null,
  sections: [{ label: "模型", summary: null, items: [citation(false)] }], highlights: [{ ...citation(true), itemId: "metadata-pick", title: "同一时段值得一看的报道" }] });
const report = (kind: ReportKind): ReportDetail => ({ kind, key: kind === "daily" ? "2026-10-04" : kind === "weekly" ? "2026-W40" : "2026-10", issueNumber: 1, title: `${SITE.name} 测试刊物`, generatedAt: at, lead: { title: "本期已验证的重要变化", leadParagraph: "本期的导读与依据。" }, leadItemId: item.id, overview: null, highlights: [citation(true)], sections: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null, mentions: [] });
const story: StoryDetail = { publicId: "metadata-story", title: "测试事件的最新进展", status: "settled", reportCount: 1, sourceCount: 1, firstReportAt: at, latestAt: at, digest: "当前可核实的事件综述。", digestUpdatedAt: "2026-10-04T09:00:00.000Z", summary: null, excerpt: null, latest: null, latestReport: null, whyHot: { participants48h: 0, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null }, developments: [], officialReports: [], timeline: [{ id: item.id, title: item.title, summary: item.summary, source: { name: item.source.name, firstParty: true }, publishedAt: at, selected: true }], heat: [], related: [], topics: [], mentions: [] };
/** The same event once a second report joined it. */
const severalReports: StoryDetail = { ...story, publicId: "metadata-story-several", reportCount: 2, sourceCount: 2 };
let web: WebServer;
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://local");
  const path = url.pathname;
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (path === "/api/site/meta") return send({ changelogVersion: "fixture" });
  if (path === "/api/site/timeline") return send({ filters: readFilters(url.searchParams), cards: [{ key: item.id, anchorAt: at, item, group: null }], nextCursor: null, hot: null, dayCounts: { "2026-10-04": 1 } });
  if (path === "/api/site/pool") return send({ filters: { ...readFilters(url.searchParams), q: url.searchParams.get("q"), tab: url.searchParams.get("tab") ?? "time" }, items: [item], page: Number(url.searchParams.get("page") ?? 1), pageCount: 3, total: 100, todayCount: 1, freshness: at });
  const article = /^\/api\/site\/items\/([^/]+?)(?:\/original)?$/.exec(path)?.[1];
  if (article && details[article]) return send(details[article]);
  if (path === `/api/site/stories/${story.publicId}`) return send(story);
  if (path === `/api/site/stories/${severalReports.publicId}`) return send(severalReports);
  const match = /^\/api\/site\/reports\/(daily|weekly|monthly)\/(.+)$/.exec(path);
  if (match) {
    const r = report(match[1] as ReportKind);
    const index = [{ key: r.key, issueNumber: 1, title: r.title, count: 1 }];
    if (match[2] === "latest-page") return send({ report: r, index });
    if (match[2]?.startsWith("navigation/")) return send({ items: index });
    if (match[2] === r.key) return send(r);
    if (match[1] === "daily" && match[2] === leadless().key) return send(leadless());
  }
  res.statusCode = 404;
  send({ code: "not_found" });
});
before(async () => { web = await startWebServer(api); });
after(async () => { await web?.stop(); });

async function page(path: string) {
  const response = await fetch(`${web.origin}${path}`);
  assert.equal(response.status, 200, web.logs());
  return cheerio.load(await response.text());
}
/** The site as every article page names it, author and publisher alike. */
const organization = () => ({ "@type": "Organization", "@id": `${web.origin}/#organization`, name: SITE.organization.name, url: web.origin, logo: { "@type": "ImageObject", url: `${web.origin}/icon.png` } });
function structured($: cheerio.CheerioAPI): Array<Record<string, unknown>> {
  return $("script[type='application/ld+json']").toArray().flatMap((node) => JSON.parse($(node).text()));
}

test("filtered feeds keep their exact content address but leave indexing to the public landing pages", async () => {
  for (const base of ["/", "/all"]) for (const query of ["channel=news", "category=ai-models", "tag=Agent", "channel=x&category=paper&tag=Agent"]) {
    const $ = await page(`${base}?${query}&utm_source=fixture&anchorAt=old&deep=1`);
    assert.equal($("meta[name=robots]").attr("content"), "noindex, follow", `${base}?${query}`);
    assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}${base}?${query}`);
    assert.ok($("main").text().includes(item.title));
  }
  const $ = await page("/all?q=Claude&tab=relevance&page=2&anchorAt=old");
  assert.equal($("meta[name=robots]").attr("content"), "noindex, follow");
  assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}/all?q=Claude&tab=relevance&page=2`);
});

test("ordinary feed pages remain indexable and normalize ignored parameters", async () => {
  for (const [requested, canonical] of [["/?channel=invalid&category=invalid&tag=%20&utm_source=fixture", "/"], ["/all?channel=all&tab=relevance&anchorAt=old&utm_source=fixture", "/all"]]) {
    const $ = await page(requested!);
    assert.equal($("meta[name=robots]").attr("content"), "max-image-preview:large");
    assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}${canonical}`);
  }
});

test("全部动态's later pages leave search to its first page and keep their links followed", async () => {
  const $ = await page("/all?channel=all&tab=relevance&anchorAt=old&page=2&utm_source=fixture");
  assert.equal($("meta[name=robots]").attr("content"), "noindex, follow");
  assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}/all?page=2`);
  assert.match($("title").text(), new RegExp(`^${SEO_TITLES.all} · 第 2 页`), "the title still names what the list is");
  assert.ok($("main").text().includes(item.title), "the page itself is unchanged");
});

test("an event page stands in search once it gathers more than one report", async () => {
  const single = await page(`/story/${story.publicId}`);
  assert.equal(single("meta[name=robots]").attr("content"), "noindex, follow", "one report: its own article page stands for it");
  const several = await page(`/story/${severalReports.publicId}`);
  assert.equal(several("meta[name=robots]").attr("content"), "max-image-preview:large");
  assert.equal(several("meta[name=googlebot]").length, 0);
});

// Chinese readers search issues by the date as they write it ("10月4日 AI 新闻"), not by the key.
for (const [kind, label, date] of [["daily", "日报", "10月4日"], ["weekly", "周报", "9月28日—10月4日"], ["monthly", "月报", "2026年10月"]] as const) {
  test(`${kind} issue metadata describes its visible lead and the permanent entry names the latest issue's date`, async () => {
    const r = report(kind);
    const $ = await page(`/${kind}/${r.key}`);
    const title = `${withSubject(label)}｜${date}：${r.lead!.title}`;
    // A daily is described by its own headlines; its lead's paragraph is that article's own description.
    const description = kind === "daily" ? `${date} ${withSubject("新闻")}：${r.lead!.title}；${item.title}。` : `${date} ${withSubject("资讯")}：${r.lead!.leadParagraph}`;
    assert.equal($("meta[name=description]").attr("content"), description);
    assert.equal($("title").text(), `${title} · ${SITE.name}`);
    assert.equal($("meta[property='og:title']").attr("content"), title);
    assert.ok($("main").text().includes(r.lead!.title));
    const article = structured($).find((entry) => entry["@type"] === "NewsArticle")!;
    assert.equal(article.headline, title);
    assert.equal(article.image, `${web.origin}/og/reports/${kind}/${r.key}.png`);
    assert.equal("dateModified" in article, false);
    const latest = await page(`/${kind}`);
    assert.equal(latest("title").text(), `${SEO_TITLES.latestReport(kind, date)} · ${SITE.name}`);
    assert.ok(latest("title").text().includes(date));
    assert.equal(latest("meta[name=description]").attr("content"), description);
    // The heading says what the page is searched by, as its title does, with the issue's full date.
    assert.equal(latest("h1#report-start .sr-only").text(), SEO_TITLES.latestReport(kind, dateLine(kind, r.key)));
  });
}

test("a daily without a lead is not headed by a report its highlights were only filled with", async () => {
  const $ = await page(`/daily/${leadless().key}`);
  const title = `${withSubject("日报")}｜10月5日`;
  assert.equal($("title").text(), `${title} · ${SITE.name}`);
  assert.equal(structured($).find((entry) => entry["@type"] === "NewsArticle")!.headline, title);
});

test("the latest issue is one page however its address is written", async () => {
  for (const path of ["/daily/", "/weekly/"]) {
    const $ = await page(path);
    assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}${path.slice(0, -1)}`, path);
  }
});

test("an issue's date reads as Chinese readers write it, across months and years", () => {
  assert.equal(reportDateLabel("daily", "2026-10-17"), "10月17日");
  assert.equal(reportDateLabel("weekly", "2026-W42"), "10月12日—18日");
  assert.equal(reportDateLabel("weekly", "2026-W53"), "12月28日—1月3日");
  assert.equal(reportDateLabel("monthly", "2026-01"), "2026年1月");
});

test("a report without an edited lead uses only a still-public visible highlight", () => {
  // An issue's highlights are among its entries; the ones a thin daily is filled with never head it (above).
  const r = { ...report("weekly"), lead: null, highlights: [citation(false), citation(true)], sections: [{ label: "模型", summary: null, items: [citation(false), citation(true)] }] };
  assert.match(reportLd(r, "/weekly/2026-W40", "导读").headline, new RegExp(item.title));
  assert.doesNotMatch(reportLd(r, "/weekly/2026-W40", "导读").headline, /已撤下/);
});

test("the homepage ties the founder to every public profile the site lists", async () => {
  const founder = SITE.organization.founder;
  const organization = structured(await page("/")).find((entry) => entry["@type"] === "Organization")!;
  if (!founder) return assert.equal("founder" in organization, false);
  assert.deepEqual((organization.founder as Record<string, unknown>).sameAs, founder.sameAs);
});
test("article metadata names its publisher, has a representative image and a date, and does not invent an update timestamp", async () => {
  const $ = await page(`/items/${item.id}`);
  const article = structured($).find((entry) => entry["@type"] === "NewsArticle")!;
  assert.equal(article.image, `${web.origin}/og/items/${item.id}.png`);
  assert.equal(article.datePublished, at);
  assert.equal("dateModified" in article, false);
  assert.equal(article.isBasedOn, detail.links.original);
  assert.deepEqual(article.author, organization());
  assert.deepEqual(article.publisher, organization());
  // Without the source's own date the page carries the time it was published here, as the page shows.
  const undated = structured(await page("/items/metadata-undated")).find((entry) => entry["@type"] === "NewsArticle")!;
  assert.equal(undated.datePublished, "2026-10-04T07:30:00.000Z");
  const modified = "2026-10-04T10:00:00.000Z";
  assert.equal(articleLd({ path: "/items/test", headline: "更正", modifiedAt: modified }).dateModified, modified);
});

test("an article whose own text is a summary's worth asks only Google not to index it", async () => {
  for (const path of ["/items/metadata-short", "/items/metadata-short/original"]) {
    const $ = await page(path);
    assert.equal($("meta[name=googlebot]").attr("content"), "noindex", path);
    assert.equal($("meta[name=robots]").attr("content"), "max-image-preview:large", `${path}: other engines keep indexing it`);
    assert.equal($("link[rel=canonical]").attr("href"), `${web.origin}/items/metadata-short`);
  }
  const ordinary = await page(`/items/${item.id}`);
  assert.equal(ordinary("meta[name=googlebot]").length, 0);
  assert.equal(ordinary("meta[name=robots]").attr("content"), "max-image-preview:large");
  const hidden = await page("/items/metadata-hidden");
  assert.equal(hidden("meta[name=robots]").attr("content"), "noindex, follow");
  assert.equal(hidden("meta[name=googlebot]").length, 0, "robots already covers Google");
});

test("story metadata describes the visible collection, current summary and report list", async () => {
  const $ = await page(`/story/${story.publicId}`);
  const collection = structured($).find((entry) => entry["@type"] === "CollectionPage")!;
  assert.ok(collection);
  assert.equal(collection.name, story.title);
  assert.equal(collection.description, story.digest);
  assert.equal(collection.dateModified, story.digestUpdatedAt);
  assert.equal("datePublished" in collection, false);
  assert.deepEqual(collection.publisher, organization());
  const list = collection.mainEntity as { itemListElement: Array<{ name: string }> };
  assert.deepEqual(list.itemListElement.map((entry) => entry.name), [item.title]);
  assert.ok($("main").text().includes(story.digest!));
});
