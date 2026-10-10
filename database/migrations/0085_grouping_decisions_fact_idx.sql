-- Related-event reads find bridge judgements through their fact on every story page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS grouping_decisions_fact_idx
  ON grouping_decisions (fact_id);
