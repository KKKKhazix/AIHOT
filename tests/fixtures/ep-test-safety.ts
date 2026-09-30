export function assertEpTestDatabase(url: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!url) throw new Error('DATABASE_URL is required. PostgreSQL tests do not silently skip or fall back to memory.');
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) throw new Error('Test DATABASE_URL must not contain query overrides or fragments.');
  if (env.NODE_ENV === 'production') throw new Error('Never run research fixtures in production.');
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !/^[a-zA-Z0-9_]+_(test|ci)$/.test(database)) {
    throw new Error('Refusing database tests: use a dedicated database ending in _test or _ci.');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (!local && env.EP_PR1_ALLOW_REMOTE_TEST_DB !== '1') throw new Error('Remote test DB requires explicit EP_PR1_ALLOW_REMOTE_TEST_DB=1.');
  for (const [key, value] of Object.entries(env)) {
    if ((key === 'COLLECT_ENABLED' || key === 'MODEL_CALLS_ENABLED' || key === 'INDEXNOW_SUBMIT_ENABLED' || /^FEISHU_.*_ENABLED$/.test(key)) && /^(true|1)$/i.test(value ?? '')) {
      throw new Error(`${key} must be disabled for tests.`);
    }
  }
}
