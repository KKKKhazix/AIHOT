// Failure cases: unchanged numbers hide an upstream edition/correction; excluded results revive
// through carry-forward; a missing public category replaces a complete run; CSV blanks become zero.
import './setup.ts';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { sql, closeDb } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { storeSnapshot } from '@aihot/backend/leaderboard/fetch/store';
import { configurationOf } from '@aihot/backend/leaderboard/fetch/configuration';
import { livebench } from '@aihot/backend/leaderboard/fetch/sources/livebench';
import { eqbench } from '@aihot/backend/leaderboard/fetch/sources/eqbench';
import type { FetchResult, ParsedRow } from '@aihot/backend/leaderboard/fetch/types';
import { buildRunInputs } from '@aihot/backend/leaderboard/method/inputs';
import { runLeaderboardRound } from '@aihot/backend/leaderboard/method/run';
import { ANCHORS, SCORING_SOURCES } from '@aihot/backend/leaderboard/method/v15';

after(closeDb);
beforeEach(async () => {
  await sql`TRUNCATE lb_models, lb_runs, lb_snapshots CASCADE`;
});

const row = (name: string, score = 50): ParsedRow => ({
  sourceModelName: name, baseName: name, rawScore: score,
  metricKey: 'livebench-coding', metricName: 'Coding', configuration: configurationOf([]),
});
const result = (rows: ParsedRow[], release = '2026-09-01'): FetchResult => ({
  sourceKey: 'livebench-coding', sourceName: 'LiveBench Coding', sourceUrl: 'https://example.org/',
  attributionUrl: 'https://example.org/', license: 'test', publishedAt: null, metadata: { release }, rows,
});
const stamp = async (id: string, days: number) => {
  const at = new Date(Date.now() - days * 86400_000);
  await sql`UPDATE lb_snapshots SET fetched_at=${at}, metadata=metadata || ${sql.json({ lastSeenAt: at.toISOString() })} WHERE id=${id}`;
};

test('the same scores in a new edition create a new snapshot', async () => {
  const original = await storeSnapshot(result([row('model-a')]));
  const repeated = await storeSnapshot(result([row('model-a')]));
  assert.equal(repeated.snapshotId, original.snapshotId);
  assert.equal(repeated.changed, false);
  const revised = await storeSnapshot(result([row('model-a')], '2026-10-01'));
  assert.notEqual(revised.snapshotId, original.snapshotId);
  const [snapshot] = await sql`SELECT metadata FROM lb_snapshots WHERE id=${revised.snapshotId}`;
  assert.equal(snapshot!.metadata.release, '2026-10-01');
});

test('rank, evaluation time and exclusion corrections are preserved even without a score change', async () => {
  const old = result([{ ...row('model-a'), sourceRank: 3, sourcePublishedAt: '2026-09-01T00:00:00Z' }]);
  const a = await storeSnapshot(old);
  const changed = structuredClone(old);
  changed.publishedAt = '2026-09-30T00:00:00Z';
  changed.rows[0]!.sourceRank = 4;
  changed.rows[0]!.sourcePublishedAt = changed.publishedAt;
  const b = await storeSnapshot(changed);
  assert.notEqual(a.snapshotId, b.snapshotId);
  const [score] = await sql`SELECT source_rank,source_published_at FROM lb_scores WHERE snapshot_id=${b.snapshotId}`;
  assert.equal(score!.source_rank, 4);
  assert.equal(score!.source_published_at.toISOString(), new Date(changed.publishedAt).toISOString());
});

test('carry-forward fills omissions, but never revives a newer excluded result or crosses an edition', async () => {
  const a = await storeSnapshot(result([row('model-a'), row('model-b'), row('model-c')]));
  await stamp(a.snapshotId, 3);
  const excluded = { ...row('model-a'), configuration: { ...configurationOf([]), ineligible: 'Mixed-model run' } };
  const b = await storeSnapshot(result([excluded, row('model-b')]));
  await stamp(b.snapshotId, 2);
  let input = await buildRunInputs();
  assert.equal(input.evidence['livebench-coding:model-a'], undefined, 'an explicit exclusion is not a missing row');
  assert.equal(input.evidence['livebench-coding:model-c']?.carriedForward, true);
  const c = await storeSnapshot(result([row('model-b', 51)]));
  await stamp(c.snapshotId, 1);
  input = await buildRunInputs();
  assert.equal(input.evidence['livebench-coding:model-a'], undefined, 'a recent exclusion still blocks older evidence when the row later vanishes');
  assert.equal(input.evidence['livebench-coding:model-c']?.carriedForward, true);
  input = await buildRunInputs({ at: new Date(Date.now() + 8 * 86400_000) });
  assert.equal(input.evidence['livebench-coding:model-c'], undefined, 'omissions expire after seven days');
  await storeSnapshot(result([row('model-b', 51)], '2026-10-01'));
  input = await buildRunInputs();
  assert.equal(input.evidence['livebench-coding:model-c'], undefined, 'old-edition omissions cannot join the new edition');
});

test('a wholly missing public category fails the round and retains the previous published run', async () => {
  await sql`INSERT INTO lb_runs (id,methodology_version,generated_at) VALUES ('previous','test',now() - interval '1 day')`;
  const add = async (key: string) => {
    const src = SCORING_SOURCES.find(s => s.key === key)!;
    await storeSnapshot({ ...result(ANCHORS.slice(0,10).map((slug,i) => ({ ...row(slug, 100-i), metricKey: src.unit }))), sourceKey: src.key });
  };
  for (const key of ['deepswe-v1-1','livebench-coding','livebench-reasoning','epoch-chess','mercor-apex-agents','vals-finance-agent']) await add(key);
  const failed = await runLeaderboardRound();
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason!, /knowledge/);
  const [latest] = await sql`SELECT id FROM lb_runs WHERE status='published' ORDER BY generated_at DESC LIMIT 1`;
  assert.equal(latest!.id, 'previous');
  await add('epoch-simpleqa');
  await add('epoch-gpqa');
  assert.equal((await runLeaderboardRound()).status, 'published');
});

test('LiveBench skips empty/missing measurements, keeps real zeros and reads quoted CSV names', async () => {
  const dispatcher = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  const upstream = mock.get('https://livebench.ai');
  const oldPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  setGlobalDispatcher(mock);
  upstream.intercept({path:'/'}).reply(200, '<script src="/static/js/main.abc.js"></script>');
  upstream.intercept({path:'/static/js/main.abc.js'}).reply(200, '["2026-08-01","2026-09-01","2026-10-01"]');
  upstream.intercept({path:'/categories_2026_10_01.json'}).reply(200, JSON.stringify({Coding:['code'], 'Agentic Coding':['agent'], Language:['lang'],IF:['if'],Reasoning:['reason'],Mathematics:['math']}));
  upstream.intercept({path:'/table_2026_10_01.csv'}).reply(200, 'Model,code,agent,lang,if,reason,math\nblank,,80,80,80,80,80\nzero,0,80,80,80,80,80\n"Quoted, model",60,80,80,80,80,80\nmissing,70\n');
  try {
    const boards = await livebench.fetch();
    const coding = boards.find(b => b.sourceKey==='livebench-coding')!;
    assert.deepEqual(coding.rows.map(r => [r.sourceModelName,r.rawScore]), [['zero',40], ['Quoted, model',70]]);
  } finally {
    setGlobalDispatcher(dispatcher);
    config.allowPrivateNetworkFetch = oldPrivate;
    await mock.close();
  }
});

test('EQ-Bench skips empty scores and reads quoted CSV names in both writing datasets', async () => {
  const dispatcher = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  const oldPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  setGlobalDispatcher(mock);
  mock.get('https://api.github.com').intercept({path:'/repos/EQ-bench/EQ-bench-site/commits?per_page=1'})
    .reply(200, [{sha:'test',commit:{committer:{date:'2026-10-01T00:00:00Z'}}}]);
  for (const [file,column] of [['creative_writing.js','elo_score'],['creative_writing_longform.js','overall_score_100']]) {
    mock.get('https://eqbench.com').intercept({path:`/${file}`})
      .reply(200, 'const data = `model_name,' + column + '\nblank,\nzero,0\n"Quoted, model",70\n`;');
  }
  try {
    for (const board of await eqbench.fetch()) assert.deepEqual(board.rows.map(r=>[r.sourceModelName,r.rawScore]), [['zero',0],['Quoted, model',70]]);
  } finally {
    setGlobalDispatcher(dispatcher);
    config.allowPrivateNetworkFetch = oldPrivate;
    await mock.close();
  }
});
