// Previously published links must survive rank 30 -> 31 and loss of current eligibility; they must
// never borrow a newer date or expose a failed run, an anonymous identity, or an unranked model.
import './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { invalidateLeaderboard, loadModel, loadBoard } from '@aihot/backend/leaderboard/read';

after(closeDb);

test('model pages retain current evidence beyond rank 30 and dated evidence after leaving the ranking', async () => {
  const oldAt = new Date('2026-09-29T00:00:00Z');
  const currentAt = new Date('2026-09-30T00:00:00Z');
  const summary = { consensus: { input: [{board:'overall',registry:{},signals:[]}], boards: [], evidence: {} } };
  for (const id of ['past','outside','unknown','failed-only','stealth-hidden']) {
    await sql`INSERT INTO lb_models (id,slug,name) VALUES (${id},${id},${id})`;
  }
  await sql`INSERT INTO lb_runs (id,methodology_version,generated_at,summary,status) VALUES
    ('old','test',${oldAt},${sql.json(summary)},'published'),
    ('current','test',${currentAt},${sql.json(summary)},'published'),
    ('failed','test',${new Date('2026-10-01T00:00:00Z')},${sql.json(summary)},'failed')`;
  await sql`INSERT INTO lb_rankings (run_id,board,model_id,rank,score) VALUES
    ('old','overall','past',1,80),('old','overall','outside',2,79),
    ('current','overall','outside',31,70),('old','overall','stealth-hidden',3,78),
    ('failed','overall','failed-only',1,99),('failed','overall','past',2,98)`;
  await sql`INSERT INTO lb_models (id,slug,name) SELECT 'top-'||n,'top-'||n,'Top '||n FROM generate_series(1,30) g(n)`;
  await sql`INSERT INTO lb_rankings (run_id,board,model_id,rank,score) SELECT 'current','overall','top-'||n,n,100-n FROM generate_series(1,30) g(n)`;
  invalidateLeaderboard();
  const outside = await loadModel('outside');
  assert.ok(outside, 'a page does not disappear when its model drops out of the displayed top 30');
  assert.equal(outside.overall.rank, 31);
  assert.equal(outside.overall.onBoard, false);
  assert.equal(outside.run.generatedAt, currentAt.toISOString());
  assert.equal(outside.historical, false);
  const past = await loadModel('past');
  assert.ok(past, 'a formerly ranked model retains its last published result');
  assert.equal(past.overall.score, 80);
  assert.equal(past.run.generatedAt, oldAt.toISOString());
  assert.equal(past.historical, true);
  assert.equal(await loadModel('unknown'), null);
  assert.equal(await loadModel('failed-only'), null);
  assert.equal(await loadModel('stealth-hidden'), null);
  assert.equal((await loadBoard('overall'))!.run.id, 'current', 'historical reads do not replace the latest-run cache');
});
