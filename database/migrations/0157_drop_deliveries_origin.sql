-- Inserts never set it and nothing reads it; deletion approved (2026-11-17).
ALTER TABLE deliveries DROP COLUMN IF EXISTS origin;
