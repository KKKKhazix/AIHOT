// Reports: a scheduled run that starts late still writes the issue it was due for, never one whose
// window is still open; an issue with nothing in it is refused rather than published empty; and an
// older weekly that froze no summaries shows the cited articles' public summaries.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadReport } from "@aihot/backend/publication/reports";
import { composeDaily, dueDaily, dueMonthly, dueWeekly } from "@aihot/backend/reports/compose";
import { SITE } from "@aihot/industry/site";

const T = tag();
const SOURCE = `test-reports-${T}`;
const WEEK = `2098-W${String(10 + Math.floor(Math.random() * 40)).padStart(2, "0")}`;
after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'weekly' AND key = ${WEEK}`;
  await stopBoss();
  await closeDb();
});

const bj = (s: string) => new Date(`${s}+08:00`);

test("a late run writes the issue that was due, not today's", () => {
  assert.equal(dueDaily(bj("2026-09-29T08:00:05")), "2026-09-29");
  assert.equal(dueDaily(bj("2026-09-30T01:00:00")), "2026-09-29", "the 29th's run delayed past midnight");
  assert.equal(dueWeekly(bj("2026-09-28T10:00:00")), "2026-W39");
  assert.equal(dueWeekly(bj("2026-10-05T09:00:00")), "2026-W39", "Monday before 10:00: the next week is not due yet");
  assert.equal(dueWeekly(bj("2026-10-05T10:01:00")), "2026-W40");
  assert.equal(dueMonthly(bj("2026-10-01T10:30:00")), "2026-09");
  assert.equal(dueMonthly(bj("2026-10-01T09:00:00")), "2026-08");
  assert.equal(dueMonthly(bj("2027-01-15T12:00:00")), "2026-12");
});

test("a daily with nothing in its window is refused, not published empty", async () => {
  const date = "2098-01-15";
  await assert.rejects(composeDaily(date), /no selected items/);
  const [row] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.equal(row, undefined);
});

test("a weekly that froze no summaries shows the articles' public summaries", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Reports', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}`, title: `R ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题-${T}`}, ${`公开摘要-${T}`}, 80, true)`;
  await publishArticle(articleId, { releasedAt: new Date() });
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
