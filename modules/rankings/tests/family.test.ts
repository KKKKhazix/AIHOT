import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sql } from "@aihot/backend/db";
import { loadFamilyRanking, loadRankings } from "../backend/publication.ts";

const now = new Date("2026-11-09T12:00:00Z");
test("family rankings use publication time for the rolling window and score ties", async () => {
  try {
    await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES ('family-test','测试来源','rss','T2','editorial')`;
    const add = async (id: string, hours: number, score: number | null, visibility = "public", eligible = true, selected = false, visibleAfter: Date | null = null, publishedHours: number | null = hours) => {
      const at = new Date(now.getTime() - hours * 3600000);
      const published = publishedHours === null ? null : new Date(now.getTime() - publishedHours * 3600000);
      await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES (${id},'family-test',${id},${`https://example.org/${id}`},${id},${at},${at})`;
      await sql`INSERT INTO publications (article_id,source_id,title,url,channel,score,visibility,eligible,selected,visible_after,published_at,discovered_at,timeline_at,sort_at)
        VALUES (${id},'family-test',${id},${`https://example.org/${id}`},'news',${score},${visibility},${eligible},${selected},${visibleAfter},${published},${at},${at},${at})`;
    };
    await add('recent', 1, 85);
    await add('tie-new', 2, 90);
    await add('tie-old', 4, 90);
    await add('three-days', 50, 99);
    await add('seven-days', 100, 98);
    await add('too-old', 169, 100);
    await add('future', -1, 100);
    await add('withdrawn', 1, 100, 'withdrawn');
    await add('ineligible', 1, 100, 'public', false);
    await add('unscored', 1, null);
    await add('old-publication', 1, 100, 'public', true, false, null, 169);
    await add('missing-publication', 1, 100, 'public', true, false, null, null);
    await add('future-publication', 1, 100, 'public', true, false, null, -1);
    await add('not-released', 1, 100, 'public', true, true, new Date(now.getTime() + 60000));
    await sql`UPDATE publications SET timeline_at = ${new Date(now.getTime() - 10 * 3600000)} WHERE article_id = 'tie-new'`;
    assert.deepEqual((await loadFamilyRanking(2, now)).map(x => x.title), ['tie-new', 'recent']);
    const recent = await loadFamilyRanking(48, now);
    assert.deepEqual(recent.map(x => x.title), ['tie-new', 'tie-old', 'recent']);
    assert.equal(recent[0].url, '/items/tie-new');
    assert.equal(recent[0].heat, '90 分');
    assert.deepEqual((await loadFamilyRanking(72, now)).map(x => x.title), ['three-days', 'tie-new', 'tie-old', 'recent']);
    assert.equal((await loadFamilyRanking(168, now))[1].title, 'seven-days');
    const boards = await loadRankings(now);
    assert.deepEqual(boards.slice(0, 4).map(b => b.name), ['2小时', '48小时', '3天', '7天']);
    assert.ok(boards.findIndex(b => b.source === '微小榜') < boards.findIndex(b => b.source === '豚榜'));
    for (let i = 0; i < 103; i++) await add(`bulk-${i}`, 1, 80);
    assert.equal((await loadFamilyRanking(48, now)).length, 100);
  } finally { await sql.end(); }
});
