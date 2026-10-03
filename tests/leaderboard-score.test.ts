// Failure contracts before implementation: rank-only points, reversed scores, fake precision on
// ties, treating absent edges as zero results, moving the baseline with entrants, invalid or
// disconnected evidence, and an unsuccessful solver must never produce publishable ratings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitScores } from '@aihot/backend/leaderboard/method/score';

function matrix(values: number[], edges?: Array<[number,number]>, weight = 1) {
  const n = values.length, models = values.map((_, i) => `m${i}`);
  const M = Array.from({length:n}, () => new Float64Array(n));
  const W = Array.from({length:n}, () => new Float64Array(n));
  for (let i=0;i<n;i++) for (let j=i+1;j<n;j++) if (!edges || edges.some(e=>e[0]===i && e[1]===j)) {
    M[i]![j] = (values[i]! - values[j]!) * weight; M[j]![i] = -M[i]![j]!;
    W[i]![j] = W[j]![i] = weight;
  }
  return {models,M,W};
}
const close = (a:number,b:number,tolerance=1e-5) => assert.ok(Math.abs(a-b)<tolerance, `${a} != ${b}`);

test('score uses continuous differences, a declared anchor baseline and a bounded scale', async () => {
  const result = await fitScores(matrix([0.5,0,-0.5]), [0,1,2], ['m1']);
  assert.equal(result.optimal,true);
  close(result.scores[0]!,75); close(result.scores[1]!,50); close(result.scores[2]!,25);
  close(result.weightedRmse!,0);
  const tiny = await fitScores(matrix([0.001,0,-0.001]), [0,1,2], ['m1']);
  assert.ok(tiny.scores[0]! > 50 && tiny.scores[0]! < 50.1);
  assert.ok(tiny.scores[0]! - tiny.scores[2]! < result.scores[0]! - result.scores[2]!);
});

test('ties are not given invented rank gaps and conflicts respect the published order', async () => {
  const tied = await fitScores(matrix([0,0,0]),[2,0,1],['m0','m1']);
  assert.equal(tied.optimal,true);
  tied.scores.forEach(x=>close(x!,50));
  const conflict = await fitScores(matrix([-0.4,0.4,0]),[0,1,2],['m2']);
  assert.equal(conflict.optimal,true);
  assert.ok(conflict.scores[0]! >= conflict.scores[1]! - 1e-6);
  assert.ok(conflict.scores[1]! >= conflict.scores[2]! - 1e-6);
  assert.ok(conflict.weightedRmse! > 0);
});

test('missing comparisons stay absent, and consistent entrants or weight units do not inflate scores', async () => {
  const sparse=await fitScores(matrix([0.5,0,-0.5],[[0,1],[1,2]]),[0,1,2],['m1']);
  const full=await fitScores(matrix([0.5,0,-0.5]),[0,1,2],['m1']);
  const scaled=await fitScores(matrix([0.5,0,-0.5],undefined,0.0001),[0,1,2],['m1']);
  const entrant=await fitScores(matrix([0.5,0,-0.5,-0.25]),[0,1,3,2],['m1']);
  for(let i=0;i<3;i++) {
    close(sparse.scores[i]!,full.scores[i]!);
    close(scaled.scores[i]!,full.scores[i]!);
    close(entrant.scores[i]!,full.scores[i]!);
  }
});

test('no anchor, disconnected data or invalid margins cannot produce scores', async () => {
  for(const r of [await fitScores(matrix([1,0]),[0,1],[]),await fitScores(matrix([1,0,-1],[[0,1]]),[0,1,2],['m1'])]) {
    assert.equal(r.optimal,false); assert.ok(r.scores.every(s=>s===null));
  }
  const bad=matrix([1,0]); bad.M[0]![1]=NaN;
  await assert.rejects(fitScores(bad,[0,1],['m1']),/invalid/i);
});
