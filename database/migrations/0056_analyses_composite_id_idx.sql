-- Evidence checks only need to know whether the publication's analysis is composite.
CREATE INDEX CONCURRENTLY IF NOT EXISTS analyses_composite_id_idx
  ON analyses (id) WHERE output->>'scope' = 'composite';
