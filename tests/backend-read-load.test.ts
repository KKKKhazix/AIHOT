import './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { latestHotRanking } from '@aihot/backend/publication/hot';
import { loadSiteStats } from '@aihot/backend/site/stats';

after(closeDb);

test('a cold read that finds nothing yet does not stick: later reads see the first published ranking', async () => {
  await sql`INSERT INTO sources (id, name, kind, participation_mode, enabled) VALUES
    ('editorial', 'Editorial', 'rss', 'editorial', true),
    ('signal', 'Signal', 'x_search', 'hot_signal', true),
    ('disabled', 'Disabled', 'rss', 'editorial', false)`;
  const together = <T>(read: () => Promise<T>) => Promise.all(Array.from({ length: 8 }, read));
  for (const stats of await together(loadSiteStats)) {
    assert.deepEqual([stats.sources, stats.sourceKinds], [2, { rss: 1, x_search: 1 }]);
  }
  assert.deepEqual(await together(latestHotRanking), Array(8).fill(null));
  const [published] = await sql`INSERT INTO hot_rankings (computed_at, rule_version, entries, published)
    VALUES (now(), 'test', '[]', true) RETURNING id`;
  assert.deepEqual((await together(latestHotRanking)).map(r => r?.id), Array(8).fill(published!.id));
});
