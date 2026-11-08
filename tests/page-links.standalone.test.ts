// What an article and an event page show readers and search engines about where else to go, written before
// the change from the ways it can go wrong:
// - an article a daily carries does not link to that daily, on wide screens or on phones, names its date
//   otherwise than the site names issues, or calls itself the lead of an issue that leads with another;
// - an article's tags send readers and crawlers to filtered lists that search engines are kept from although
//   a topic page covers the tag, or a tag repeats the topic chip beside it;
// - an event page shows no date of its own: when it was first reported, in Beijing time, and of which year
//   when not this one.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as cheerio from "cheerio";
import type { SiteItemDetail, StoryDetail } from "@aihot/contracts/site";
import { beijingDate } from "@aihot/contracts/time";
import { ITEM_COPY, withSubject } from "@aihot/site";
import { fakeApi, FIXTURE_AT, itemDetail, startWebServer, type WebServer } from "../apps/web/tests/web-server.ts";

const agent = { slug: "agent", name: "Agent 智能体" };
const items: SiteItemDetail[] = [
  itemDetail({ id: "links-lead", title: "日报头条", topics: [agent], daily: { key: "2026-11-07", lead: true } }),
  itemDetail({ id: "links-entry", title: "日报里的一条", daily: { key: "2026-11-07", lead: false } }),
  itemDetail({ id: "links-none", title: "没进日报" }),
  // Tagged with a company its title does not name: that company's topic is the tag's, not the article's.
  itemDetail({ id: "links-tags", title: "带标签", topics: [agent], tags: ["Agent", "OpenAI", "框架"], tagTopics: { Agent: "agent", OpenAI: "openai" } }),
];
// A minute ago: this year's, unless the test runs in the first minute of one.
const recent = new Date(Date.now() - 60_000).toISOString();
const story = (publicId: string, firstReportAt: string | null): StoryDetail => ({
  publicId, title: "测试事件", status: "settled", reportCount: 61, sourceCount: 20, firstReportAt, latestAt: firstReportAt ?? FIXTURE_AT, digest: null, digestUpdatedAt: null,
  summary: null, excerpt: null, latest: null, latestReport: null,
  whyHot: { participants48h: 0, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null },
  developments: [], officialReports: [], timeline: [], heat: [], related: [], topics: [], mentions: [],
});
const stories = [story("links-this-year", recent), story("links-last-year", "2025-12-30T17:00:00.000Z"), story("links-undated", null)];

let web: WebServer;
before(async () => {
  web = await startWebServer(fakeApi((url) => {
    const item = items.find((i) => url.pathname === `/api/site/items/${i.id}`);
    if (item) return item;
    return stories.find((s) => url.pathname === `/api/site/stories/${s.publicId}`);
  }));
});
after(async () => { await web?.stop(); });

async function page(path: string) {
  const response = await fetch(`${web.origin}${path}`);
  assert.equal(response.status, 200, web.logs());
  return cheerio.load(await response.text());
}

/** The headings of the rail that has `heading`, in order. */
function railOf($: cheerio.CheerioAPI, heading: string): string[] {
  const rail = $("h2").filter((_, el) => $(el).text() === heading).closest("aside");
  assert.equal(rail.length, 1, heading);
  return rail.find("h2").toArray().map((el) => $(el).text());
}

test("an article a daily carries links to that issue, in the rail and first among the phone chips", async () => {
  const daily = withSubject("日报");
  for (const [id, name] of [["links-lead", `11月7日 ${daily} · 头条`], ["links-entry", `11月7日 ${daily}`]] as const) {
    const $ = await page(`/items/${id}`);
    const links = $("a[href='/daily/2026-11-07']");
    // On phones it heads the row of topic and tag chips at the end of the text; wide screens have it in the rail.
    assert.deepEqual(links.toArray().map((el) => $(el).text()), [`收录于 ${name}`, name], id);
    const chip = links.eq(0);
    assert.ok(chip.closest("article").length && chip.is(chip.parent().children().first()), id);
    assert.equal(links.eq(1).closest("section").find("h2").text(), "收录于");
  }
  // Between the reason and the topics.
  assert.deepEqual(railOf(await page("/items/links-lead"), "收录于"), [ITEM_COPY.reasonLabel, "收录于", "主题"]);
  const $ = await page("/items/links-none");
  assert.equal($("a[href^='/daily/2']").length, 0);
  assert.equal($("h2").filter((_, el) => $(el).text() === "收录于").length, 0);
});

test("a tag that is a topic's own leads to the topic page, and not beside that topic's chip", async () => {
  const $ = await page("/items/links-tags");
  const hrefs = (text: string) => $("a").filter((_, el) => $(el).text() === text).toArray().map((el) => $(el).attr("href"));
  // The rail and the phone chips alike.
  assert.deepEqual(hrefs("Agent 智能体"), ["/topics/agent", "/topics/agent"]);
  assert.deepEqual(hrefs("#Agent"), []);
  assert.deepEqual(hrefs("#OpenAI"), ["/topics/openai", "/topics/openai"]);
  assert.deepEqual(hrefs("#框架"), [`/all?tag=${encodeURIComponent("框架")}`, `/all?tag=${encodeURIComponent("框架")}`]);
  assert.equal($("a[href^='/all?tag=Agent']").length, 0);
});

test("an event page says when it was first reported, by the Beijing day and its year when not this one", async () => {
  const day = beijingDate(recent);
  for (const [id, date, at] of [["links-this-year", `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`, recent], ["links-last-year", "2025年12月31日", "2025-12-30T17:00:00.000Z"]] as const) {
    const header = (await page(`/story/${id}`))("h1").closest("header");
    const line = header.text();
    assert.ok(line.includes(`${date}首报`), `${id}: ${line}`);
    assert.ok(line.indexOf("个报道来源") < line.indexOf("首报") && line.indexOf("首报") < line.indexOf("更新"), line);
    assert.equal(header.find("time").attr("datetime"), at);
  }
  const undated = await page("/story/links-undated");
  assert.ok(!undated("h1").closest("header").text().includes("首报"));
});
