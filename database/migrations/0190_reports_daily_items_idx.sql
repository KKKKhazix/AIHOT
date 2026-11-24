-- An article links to the first daily that still lists it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reports_daily_items_idx
  ON reports USING gin (jsonb_path_query_array(content, 'strict $.**.itemId')) WHERE kind = 'daily';
