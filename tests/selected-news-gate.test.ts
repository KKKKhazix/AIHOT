// Failure cases before implementation: elapsed time or a stale grouped_at must not publish an
// unresolved selection; it stays readable in all. Completion publishes once across every outlet;
// another report cannot push the same news again; low incremental value stays outside selection.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { selectedContent } from "@aihot/backend/notify/selected-content";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `news-gate-${T}`;
const app = await buildApp();
before(async () => {
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${SOURCE},'News gate','rss','T1','editorial','2100-01-01')`;
  // This file's clock moves only when a test moves it: past the public timeline's five-second
  // grouped snapshot (Date.now) instead of waiting for it.
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
});
after(async () => { mock.timers.reset(); await app.close(); await stopBoss(); await closeDb(); });

async function candidate(name: string) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${T}/${name}`,
    title: `${T} ${name}`, bodyText: 'A new public result with evidence.', bodyStatus: 'ok', via: 'fetch', publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','ai-models',${`新闻 ${T} ${name}`},'有证据的新结果','推荐理由',90,true)`;
  return articleId;
}
const read = async (path: string) => (await app.inject({ method: 'GET', url: path })).body;

test('an unresolved selection never leaks after the old deadline and completion publishes it everywhere', async () => {
  const id = await candidate('timeout');
  await sql`UPDATE articles SET grouping_status='failed',grouped_at=now()-interval '1 hour',grouping_error='provider timeout' WHERE id=${id}`;
  await publishArticle(id, { now: new Date(Date.now() - 3600_000) });
  await publishArticle(id);
  const selectedOutlets = ['/api/site/timeline?limit=40','/api/v1/items?mode=selected',
    '/feed.xml','/api/v1/agent/latest?limit=30','/api/v1/selected/snapshot?limit=1000'];
  for (const path of selectedOutlets) assert.ok(!(await read(path)).includes(id), `${path} exposed unresolved news`);
  for (const path of ['/api/site/pool', '/api/v1/items?mode=all', `/api/site/items/${id}`]) {
    assert.ok((await read(path)).includes(id), `${path} hid otherwise readable content`);
  }
  assert.equal((await selectedContent(id)).status, 'skipped');
  assert.equal((await sql`SELECT 1 FROM selected_ledger WHERE article_id=${id}`).length, 0, 'no premature sync upsert');
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name='notify.selected' AND data->>'articleId'=${id}`).length, 0);

  await sql`UPDATE articles SET grouping_status='complete',grouped_at=now(),grouping_error=NULL,selection_adds_value=true WHERE id=${id}`;
  await publishArticle(id);
  mock.timers.tick(5_100); // the public timeline's existing five-second grouped snapshot expires
  for (const path of selectedOutlets) assert.ok((await read(path)).includes(id), `${path} missed completed news`);
  assert.equal((await selectedContent(id)).status, 'ready');
  await publishArticle(id);
  assert.equal((await sql`SELECT 1 FROM selected_ledger WHERE article_id=${id} AND op='upsert'`).length, 1);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name='notify.selected' AND data->>'articleId'=${id}`).length, 1);
});

test('a confirmed but redundant explanation stays in all, and an editor can explicitly select it', async () => {
  const id = await candidate('overlap');
  await sql`UPDATE articles SET grouping_status='complete',grouped_at=now(),selection_adds_value=false,
    selection_value_reason='已选发布稿已经包含全部要点' WHERE id=${id}`;
  await publishArticle(id);
  mock.timers.tick(5_100); // read past the previous test's snapshot, or this check passes on stale rows
  assert.ok(!(await read('/api/site/timeline?limit=40')).includes(id));
  assert.ok((await read('/api/v1/items?mode=all')).includes(id));
  assert.equal((await selectedContent(id)).status, 'skipped');
  await sql`INSERT INTO editorial_overrides(article_id,fields,reason,updated_by)
    VALUES (${id},'{"selected":true}','editor verified independent value','test')`;
  await publishArticle(id);
  mock.timers.tick(5_100);
  assert.ok((await read('/api/site/timeline?limit=40')).includes(id));
});
