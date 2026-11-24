CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_search_summary_idx ON publications USING hash (summary) WHERE eligible OR selected;
