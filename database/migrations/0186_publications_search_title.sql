CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_search_title_idx ON publications USING hash (title) WHERE eligible OR selected;
