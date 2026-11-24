CREATE INDEX CONCURRENTLY IF NOT EXISTS job_runs_running_idx ON job_runs (id) WHERE status = 'running';
