// Reports: a scheduled run that starts late still writes the issue it was due for, never one whose
// window is still open; a daily whose window published nothing is an ordinary quiet day, while one that
// published reports but judged none is a silent issue (a different lead, and an operations alert); and an
// older weekly that froze no summaries shows the cited articles' public summaries.
import { editionAt, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadReport } from "@aihot/backend/publication/reports";
import { composeDaily, dueDaily, dueMonthly, dueWeekly } from "@aihot/backend/reports/compose";
import { REPORTS, SITE } from "@aihot/site";

const T = tag();
const SOURCE = `test-reports-${T}`;
const SILENT_SOURCE = `test-reports-silent-${T}`;
const WEEK = "2098-W20";
after(async () => {
  await stopBoss();
  await closeDb();
});

test("a late run writes the issue that was due, not today's", () => {
  assert.equal(dueDaily(editionAt("daily", "2026-09-29", 6)), "2026-09-29");
  assert.equal(dueDaily(editionAt("daily", "2026-09-30", -60)), "2026-09-29", "the 29th's run delayed until just before the next issue");
  assert.equal(dueWeekly(editionAt("weekly", "2026-09-28")), "2026-W39");
  assert.equal(dueWeekly(editionAt("weekly", "2026-10-05", -60)), "2026-W39", "Monday before its edition time: the next week is not due yet");
  assert.equal(dueWeekly(editionAt("weekly", "2026-10-05", 60)), "2026-W40");
  assert.equal(dueMonthly(editionAt("monthly", "2026-10-01")), "2026-09");
  assert.equal(dueMonthly(editionAt("monthly", "2026-10-01", -60)), "2026-08");
  assert.equal(dueMonthly(editionAt("monthly", "2027-01-15")), "2026-12");
});

interface DailyContent { silent: boolean; silentReason: string | null; lead: { title: string }; generator: Record<string, number> }
const savedDaily = async (date: string) => (await sql<{ content: DailyContent }[]>`
  SELECT content FROM reports WHERE kind = 'daily' AND key = ${date}`)[0]!.content;

test("a daily whose window published nothing is an ordinary quiet issue", async () => {
  const date = "2098-01-15";
  assert.deepEqual(await composeDaily(date), { key: date, entries: 0 });
  const content = await savedDaily(date);
  assert.equal(content.silent, false, "0 publications is a quiet day, not an upstream failure");
  assert.equal(content.silentReason, null);
  assert.equal(content.lead.title, REPORTS.quiet.title);
  assert.equal(content.generator.publishedReports, 0);
  assert.equal(content.generator.judgedReports, 0);
});

test("a daily whose window published reports but judged none is a silent issue, not a quiet day", async () => {
  const date = "2098-01-16";
  const at = editionAt("daily", date, -3600);
  const id = `silent-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SILENT_SOURCE}, 'Reports silent', 'rss', 'T1', 'editorial', '2100-01-01')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
            VALUES (${id}, ${SILENT_SOURCE}, ${id}, 'https://example.com/silent', ${id}, ${at}, ${at})`;
  // Published to the site but never scored or selected: the analysis did not run in this window.
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score)
            VALUES (${id}, ${id}, ${SILENT_SOURCE}, 'news', 'https://example.com/silent', ${at}, ${at}, ${at}, true, false, ${at}, 'public', NULL)`;
  assert.deepEqual(await composeDaily(date), { key: date, entries: 0 });
  const content = await savedDaily(date);
  assert.equal(content.silent, true);
  assert.match(content.silentReason ?? "", /发布了 1 篇内容/);
  assert.match(content.silentReason ?? "", /没有判定结果/);
  assert.equal(content.lead.title, "本期没有可判定的内容");
  assert.equal(content.generator.publishedReports, 1);
  assert.equal(content.generator.judgedReports, 0);
});

test("a weekly that froze no summaries shows the articles' public summaries", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Reports', 'rss', 'T1', 'editorial', '2100-01-01')`;
  // Found, published and released a minute ago: a rolling window that ends at the reader's clock holds it.
  const minuteAgo = new Date(Date.now() - 60_000);
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}`, title: `R ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: minuteAgo, discoveredAt: minuteAgo });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题-${T}`}, ${`公开摘要-${T}`}, 80, true)`;
  await publishArticle(articleId, { releasedAt: minuteAgo });
  const content = { kind: "weekly", title: `${SITE.name} 周报 · ${WEEK}`, overview: "o", themes: [{ heading: "h", summary: "s", storyRefs: [{ itemId: articleId, title: `标题-${T}`, sourceName: "Old aggregator", sourceId: "old-source", firstParty: false, sourceUrl: "https://example.com" }] }] };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('weekly', ${WEEK}, now(), now(), ${sql.json(content as never)}, now(), 'imported')`;
  const report = await loadReport("weekly", WEEK);
  assert.equal(report?.sections[0]?.items[0]?.summary, `公开摘要-${T}`);
  assert.equal(report?.sections[0]?.items[0]?.sourceName, "Reports");
  assert.equal(report?.sections[0]?.items[0]?.firstParty, true, "a frozen citation cannot override verified current provenance");
  await sql`UPDATE sources SET tier = 'T1_5', first_party = true WHERE id = ${SOURCE}`;
  await publishArticle(articleId);
  assert.equal((await loadReport("weekly", WEEK))?.sections[0]?.items[0]?.firstParty, false);
});
