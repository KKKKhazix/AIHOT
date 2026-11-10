CREATE INDEX CONCURRENTLY IF NOT EXISTS external_ranking_snapshots_pending_idx ON external_ranking_snapshots (status, fetched_at);
