-- Sibling deduplication should seek a subject, not scan the target's entire delivery history.
CREATE INDEX deliveries_subject_idx ON deliveries (target_key, subject_kind, subject_id)
  WHERE status IN ('pending', 'sending', 'sent', 'unknown');
