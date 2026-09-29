// A selected item released across the 08:00 boundary must appear in the next issue exactly once.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { candidates } from "@aihot/backend/reports/compose";
import { tag } from "./setup.ts";

const T = tag();
const SOURCE = `test-report-boundary-${T}`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, 'Report boundary test', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(closeDb);

async function selected(label: string, timelineAt: string, releasedAt: string): Promise<string> {
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/report-boundary-${T}-${label}`,
    title: `Report boundary ${label}`,
    bodyText: `Report boundary ${label} body`,
    bodyStatus: "ok",
    publishedAt: new Date(timelineAt),
    discoveredAt: new Date(timelineAt),
    via: "fetch",
  });
  assert.equal(backfill, false);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${`标题 ${label}`}, ${`摘要 ${label}`}, 90, true)`;
  const published = await publishArticle(articleId, { releasedAt: new Date(releasedAt) });
  assert.equal(published?.selected, true);
  return articleId;
}

test("reports assign delayed and boundary releases to the period readers first see them", async () => {
  const onTime = await selected("on-time", "2020-01-01T23:58:00Z", "2020-01-01T23:59:00Z");
  const delayed = await selected("delayed", "2020-01-01T23:59:00Z", "2020-01-02T00:02:00Z");
  const atBoundary = await selected("at-boundary", "2020-01-01T23:59:00Z", "2020-01-02T00:00:00Z");
  const boundary = new Date("2020-01-02T00:00:00Z"); // 08:00 Beijing
  const previous = new Set((await candidates(new Date("2020-01-01T00:00:00Z"), boundary)).map((c) => c.itemId));
  const next = new Set((await candidates(boundary, new Date("2020-01-03T00:00:00Z"))).map((c) => c.itemId));

  assert.equal(previous.has(onTime), true);
  assert.equal(next.has(onTime), false);
  for (const id of [delayed, atBoundary]) {
    assert.equal(previous.has(id), false);
    assert.equal(next.has(id), true);
  }
});
