// Previously published links must survive rank 30 -> 31 and loss of current eligibility; they must
// never borrow a newer date or expose a failed run, an anonymous identity, or an unranked model.
// Previous versions must not be relabelled as the current score on historical pages.
import './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { invalidateLeaderboard, loadModel, loadBoard, loadRulesData } from '@aihot/backend/leaderboard/read';

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
  assert.equal(past.overall.rank, 1);
  assert.equal(past.overall.score, null);
  assert.equal('confidence' in past.overall, false);
  assert.equal(past.run.generatedAt, oldAt.toISOString());
  assert.equal(past.historical, true);
  assert.equal(await loadModel('unknown'), null);
  assert.equal(await loadModel('failed-only'), null);
  assert.equal(await loadModel('stealth-hidden'), null);
  assert.equal((await loadBoard('overall'))!.run.id, 'current', 'historical reads do not replace the latest-run cache');
});

// A model with strong specialised results must not silently disappear just because its evidence
// cannot yet support an overall reference position; neither its real coverage nor its link is lost.
test('a category leader with insufficient overall breadth remains visible with its actual evidence', async () => {
  const summary = { budgets: [{ key:'coding',name:'编程',weight:0.125 }], consensus: {
    input: [
      { board:'overall', registry:{ 'deepswe-v1-1':{weight:0.125,budget:'coding',operator:'datacurve'} }, signals:[] },
      { board:'coding', registry:{ 'deepswe-v1-1':{weight:1,budget:'coding',operator:'datacurve'} }, signals:[] },
    ], boards:[], evidence:{ 'deepswe-v1-1:specialist':{unit:'deepswe-v1-1',snapshotId:'none',configuration:'default'} },
  } };
  await sql`INSERT INTO lb_models (id,slug,name) VALUES ('specialist','specialist','Specialist')`;
  await sql`INSERT INTO lb_runs (id,methodology_version,generated_at,summary,status)
    VALUES ('specialist-run','test','2026-10-03',${sql.json(summary)},'published')`;
  await sql`INSERT INTO lb_rankings (run_id,board,model_id,rank,coverage)
    VALUES ('specialist-run','coding','specialist',1,1)`;
  invalidateLeaderboard();
  const board = await loadBoard('overall');
  assert.equal(board!.pending[0]!.model.slug, 'specialist');
  assert.equal(board!.pending[0]!.sources, 1);
  const detail = await loadModel('specialist');
  assert.equal(detail!.historical,false);
  assert.equal(detail!.overall.rank,null);
  assert.equal(detail!.overall.coverage,0.125);
});

// A registered reference source is not evidence used by this published round. Splitting one
// source into multiple measurement units must also not duplicate its name in the rules.
test('rule budget cards list only evidence in the published overall comparison', async () => {
  const summary = { budgets: [
    {key:'coding',name:'编程',weight:0.125}, {key:'multilingual',name:'中文与多语言',weight:0.125},
  ], sources: [
    {key:'livebench-coding',weight:0.0625},
    {key:'taptap-maker',weight:0},
    {key:'artificial-analysis-multilingual',weight:0},
  ], consensus: {input:[{board:'overall',registry:{
    'livebench-coding:direct':{weight:0.0625,budget:'coding',operator:'livebench'},
    'livebench-coding:agentic':{weight:0.0625,budget:'coding',operator:'livebench'},
    'taptap-maker':{weight:0,budget:'coding',operator:'taptap'},
  },signals:[]}],boards:[],evidence:{}} };
  await sql`INSERT INTO lb_runs (id,methodology_version,generated_at,summary,status)
    VALUES ('rules-run','test','2026-10-04',${sql.json(summary)},'published')`;
  invalidateLeaderboard();
  const rules = await loadRulesData();
  assert.deepEqual(rules.budgets[0]!.sources,['LiveBench · 编程综合']);
  assert.deepEqual(rules.budgets[1]!.sources,[]);
  assert.equal(rules.budgets[1]!.weight,0.125,'missing evidence retains its allocated share');
});

// Score, coverage and qualification are separate facts; every current ranked entry reads the
// persisted score, while an unqualified or old-method model never acquires a score on page read.
test('current scores are identical on board and detail without replacing coverage', async () => {
  const summary = { consensus:{input:[{board:'overall',registry:{},signals:[]}],boards:[],evidence:{}} };
  await sql`INSERT INTO lb_models (id,slug,name) VALUES ('rated','rated','Rated')`;
  await sql`INSERT INTO lb_runs (id,methodology_version,generated_at,summary,status)
    VALUES ('rated-run','2026.10-observed-evidence-v17','2026-10-05',${sql.json(summary)},'published')`;
  await sql`INSERT INTO lb_rankings (run_id,board,model_id,rank,score,coverage,detail)
    VALUES ('rated-run','overall','rated',1,83.47,0.625,'{"scoreVersion":"2026.10-pairwise-fit-v1"}')`;
  invalidateLeaderboard();
  const board=await loadBoard('overall'), detail=await loadModel('rated');
  assert.equal(board!.entries[0]!.score,83.47);
  assert.equal(detail!.overall.score,83.47);
  assert.equal(detail!.overall.coverage,0.625);
});
