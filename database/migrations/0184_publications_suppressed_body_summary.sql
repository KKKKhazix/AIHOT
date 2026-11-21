-- Withheld original text is published as a summary and never syndicated (publication/publish.ts), so readers
-- check body_mode alone. NOT VALID: production had no row breaking it when added (2026-11-22, 323 withheld).
ALTER TABLE publications ADD CONSTRAINT publications_suppressed_body_summary CHECK (NOT suppress_original OR (body_mode = 'summary' AND NOT syndicate)) NOT VALID;
