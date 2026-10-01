-- Preserve the identity of an explicit evaluation across extraction, retry and receipt recovery.
ALTER TABLE articles ADD COLUMN processing_attempt_tag text;
