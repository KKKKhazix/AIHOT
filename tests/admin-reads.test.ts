// Read optimization failures: source pagination changes its order or history-based statistics,
// or independent detail reads lose the missing-source result.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { listSources, sourceDetail } from "@aihot/backend/admin/sources";

after(closeDb);

test("source pages retain order and count selected history regardless of public visibility", async () => {
  await sql`
    INSERT INTO sources (id, name, kind, health, enabled)
    SELECT 'page-' || lpad(n::text, 3, '0'), 'Page ' || lpad(n::text, 3, '0'), 'rss',
           CASE WHEN n = 103 THEN 'failing' WHEN n = 102 THEN 'degraded' WHEN n = 104 THEN 'paused' ELSE 'ok' END,
           n <> 104
    FROM generate_series(1, 104) n`;
  await sql`
    INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    SELECT 'page-item-' || n, 'page-001', 'page-item-' || n, 'https://example.com/page/' || n, 'Page item ' || n,
           now() - make_interval(days => n * 10), now() - make_interval(days => n * 10)
    FROM generate_series(0, 4) n`;
  await sql`
    INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, visibility, selected)
    SELECT id, title, source_id, 'news', url, discovered_at, timeline_at, timeline_at, 'withdrawn', true
    FROM articles WHERE source_id = 'page-001'`;
  const first = await listSources({ q: "Page" });
  assert.equal(first.rows.length, 100);
  assert.deepEqual(first.rows.slice(0, 3).map(row => row.id), ["page-103", "page-102", "page-001"]);
  assert.equal(first.rows[2]!.items_7d, 1);
  assert.equal(first.rows[2]!.selected_30d, 3);
  const second = await listSources({ q: "Page", page: 2 });
  assert.deepEqual(second.rows.map(row => row.id), ["page-099", "page-100", "page-101", "page-104"]);
  assert.deepEqual(second.totals, first.totals);
  const detail = await sourceDetail("page-001");
  assert.deepEqual(detail?.stats, { total: 5, last7d: 1, selected: 5 });
  assert.equal(await sourceDetail("missing-admin-source"), null);
});
