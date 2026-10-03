-- A missing identity result is unresolved, not evidence that a report is independent.
ALTER TABLE articles ADD COLUMN grouping_status text NOT NULL DEFAULT 'pending'
  CHECK (grouping_status IN ('pending', 'complete', 'failed'));
ALTER TABLE articles ADD COLUMN grouping_receipt_id bigint REFERENCES receipts(id) ON DELETE SET NULL;
ALTER TABLE articles ADD COLUMN grouping_error text;
ALTER TABLE articles ADD COLUMN selection_adds_value boolean;
ALTER TABLE articles ADD COLUMN selection_value_reason text;

-- Preserve already released history and explicit decisions. Repair only evidenced unfinished work.
UPDATE articles a SET grouping_status = 'complete'
WHERE a.grouped_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id AND p.selected)
  OR EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.article_id = a.id AND fa.role IN ('primary', 'report'))
  OR EXISTS (SELECT 1 FROM grouping_overrides o WHERE o.article_id = a.id);

-- Queue tables exist after the worker starts; an empty installation has none to repair.
DO $$ BEGIN
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    WITH failed AS (
      SELECT DISTINCT ON (j.data->>'articleId') j.data->>'articleId' AS article_id, j.output, j.started_on
      FROM pgboss.job j WHERE j.name = 'events.group' AND j.state = 'failed'
      ORDER BY j.data->>'articleId', j.started_on DESC
    )
    UPDATE articles a SET grouping_status = 'failed', grouped_at = NULL,
      grouping_error = coalesce(f.output->>'message', 'Previous grouping did not finish'),
      grouping_receipt_id = (
        SELECT r.id FROM receipts r WHERE (r.subject = 'article:' || a.id OR r.subject LIKE 'article:' || a.id || ':fact:%')
          AND r.purpose IN ('group_article', 'group_signal', 'group_review', 'embedding') AND r.status IN ('unknown', 'failed')
        ORDER BY r.updated_at DESC LIMIT 1)
    FROM failed f WHERE a.id = f.article_id
      AND NOT EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.article_id = a.id AND fa.role IN ('primary', 'report'))
      AND NOT EXISTS (SELECT 1 FROM grouping_overrides o WHERE o.article_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM grouping_decisions d WHERE d.article_id = a.id AND d.created_at > f.started_on);
  END IF;
END $$;

CREATE INDEX articles_grouping_pending_idx ON articles (created_at)
  WHERE grouping_status = 'pending' AND processing_state = 'analyzed';
CREATE INDEX articles_grouping_receipt_idx ON articles (grouping_receipt_id)
  WHERE grouping_receipt_id IS NOT NULL;
