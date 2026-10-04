-- A channel's deeper pages retain their time order without scanning and sorting every category.
CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_pool_channel_timeline_idx
  ON publications (channel, timeline_at DESC, article_id DESC)
  INCLUDE (category, source_id, selected, visible_after)
  WHERE visibility = 'public' AND eligible;
