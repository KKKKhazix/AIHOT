-- Filtered pool pages and capped counts read narrow rows in their displayed order.
CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_pool_category_timeline_idx
  ON publications (category, timeline_at DESC, article_id DESC)
  INCLUDE (channel, source_id, selected, visible_after)
  WHERE visibility = 'public' AND eligible;
