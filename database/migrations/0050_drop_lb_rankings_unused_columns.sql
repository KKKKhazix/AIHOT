-- Ranking rows are written and read by run_id, board, model_id, rank, score, coverage and detail only.
-- Nothing writes these five columns any more, and nothing reads their earlier values.
ALTER TABLE lb_rankings
  DROP COLUMN IF EXISTS uncertainty,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS metric_count,
  DROP COLUMN IF EXISTS summary,
  DROP COLUMN IF EXISTS component_scores;
