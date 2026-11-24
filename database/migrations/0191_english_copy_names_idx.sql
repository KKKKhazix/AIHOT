CREATE INDEX CONCURRENTLY IF NOT EXISTS english_copy_names_idx ON english_copy (kind) WHERE kind = 'name' AND en IS NOT NULL;
