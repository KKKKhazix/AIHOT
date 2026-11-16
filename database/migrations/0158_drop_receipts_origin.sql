-- Inserts never set it and nothing reads it; receipt_attempts.origin is the one that is read; deletion approved (2026-11-17).
ALTER TABLE receipts DROP COLUMN IF EXISTS origin;
