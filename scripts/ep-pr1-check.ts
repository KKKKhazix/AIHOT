// Run from the repository root with Node >=24.11 and installed workspace dependencies.
// Never starts the worker/web/app, never reads .env, never calls a model.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertEpTestDatabase } from '../tests/fixtures/ep-test-safety.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major < 24 || (major === 24 && minor < 11)) {
  throw new Error('AIHOT baseline requires Node >=24.11.');
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run tests from a production environment.');
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  MODEL_CALLS_ENABLED: 'false',
  COLLECT_ENABLED: 'false',
  INDEXNOW_SUBMIT_ENABLED: 'false',
  NODE_ENV: 'test',
};
for (const key of Object.keys(env)) {
  if (/^FEISHU_.*_ENABLED$/.test(key)) env[key] = 'false';
}
// Deliberately validate before importing or running the upstream DB/config module.
assertEpTestDatabase(process.env.DATABASE_URL, env);
function run(args: string[]): void {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Uses the existing migration ledger. Only target a dedicated empty/migrated test database.
run(['scripts/migrate.ts']);
run([
  '--test', '--test-concurrency=1', '--test-timeout=120000',
  'tests/ep-research.unit.test.ts', 'tests/ep-research.pg.test.ts',
]);
