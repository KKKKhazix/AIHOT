-- Selected feeds ordered by original publication time should not sort the complete selected set.
CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_selected_published_idx
  ON publications (coalesce(published_at, discovered_at) DESC, article_id DESC)
  WHERE visibility = 'public' AND selected AND seat;
