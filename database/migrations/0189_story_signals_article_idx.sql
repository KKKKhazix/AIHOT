-- Matching recent discussion posts looks up evidence by article before its story is known.
CREATE INDEX CONCURRENTLY IF NOT EXISTS story_signals_article_idx ON story_signals (article_id);
