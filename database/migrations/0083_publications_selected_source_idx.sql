-- Source history counts include selected material outside the public feeds as well.
CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_selected_source_idx
  ON publications (source_id, discovered_at)
  WHERE selected;
