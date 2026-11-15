-- Stored vectors are found by text, so an article with another's exact text reuses its vector.
CREATE INDEX CONCURRENTLY IF NOT EXISTS embeddings_text_hash_idx ON embeddings (text_hash);
