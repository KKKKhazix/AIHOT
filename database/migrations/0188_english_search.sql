CREATE INDEX CONCURRENTLY IF NOT EXISTS english_copy_search_idx ON english_copy USING gin (lower(en) gin_trgm_ops);
