CREATE INDEX CONCURRENTLY IF NOT EXISTS fetch_runs_running_idx ON fetch_runs (id) WHERE status = 'running';
